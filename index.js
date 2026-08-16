import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import axios from "axios";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

// Polyfill necessário: o supabase-js espera um WebSocket global disponível
// no ambiente Node (no navegador ele já existe nativamente).
globalThis.WebSocket = WebSocket;

const exec = promisify(execCb);
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const WORK_DIR = "/tmp/jobs";
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ---------- STEP 1: baixar áudio+vídeo do YouTube ----------
async function baixarVideo(youtubeUrl, jobDir) {
  const videoPath = path.join(jobDir, "original.mp4");
  await exec(
    `yt-dlp -f "bestvideo[height<=1080]+bestaudio/best" --merge-output-format mp4 -o "${videoPath}" "${youtubeUrl}"`
  );
  return videoPath;
}

// ---------- STEP 2: transcrever com AssemblyAI ----------
async function transcrever(videoPath) {
  // upload do arquivo
  const fileStream = fs.createReadStream(videoPath);
  const uploadRes = await axios.post(
    "https://api.assemblyai.com/v2/upload",
    fileStream,
    { headers: { authorization: ASSEMBLYAI_KEY } }
  );
  const audioUrl = uploadRes.data.upload_url;

  // pedir transcrição
  const transcriptRes = await axios.post(
    "https://api.assemblyai.com/v2/transcript",
    { audio_url: audioUrl },
    { headers: { authorization: ASSEMBLYAI_KEY } }
  );
  const transcriptId = transcriptRes.data.id;

  // poll até terminar
  let transcript;
  while (true) {
    const poll = await axios.get(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { headers: { authorization: ASSEMBLYAI_KEY } }
    );
    if (poll.data.status === "completed") {
      transcript = poll.data;
      break;
    }
    if (poll.data.status === "error") {
      throw new Error("Falha na transcrição: " + poll.data.error);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return transcript; // contém .words com timestamps e .text
}

// ---------- STEP 3: escolher melhores trechos com Gemini ----------
async function escolherTrechos(transcript) {
  const textoComTempo = transcript.words
    .map((w) => `[${(w.start / 1000).toFixed(1)}s] ${w.text}`)
    .join(" ");

  const prompt = ` Você é um editor de vídeos virais. Abaixo está a transcrição de um vídeo longo, com o tempo (em segundos) de cada palavra. Identifique de 4 a 6 trechos com potencial viral (histórias completas, momentos de impacto, dados surpreendentes, virada de emoção). Cada trecho deve ter entre 30 e 75 segundos. Responda APENAS em JSON, neste formato exato, sem texto antes ou depois: [{"inicio": 12.5, "fim": 58.2, "titulo": "Título curto e chamativo"}] Transcrição: ${textoComTempo.slice(0, 30000)} `.trim();

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    { contents: [{ parts: [{ text: prompt }] }] }
  );

  const raw = res.data.candidates[0].content.parts[0].text;
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ---------- STEP 4: cortar com ffmpeg + legenda ----------
async function cortarClipe(videoPath, trecho, jobDir, index, transcript) {
  const outPath = path.join(jobDir, `clipe_${index}.mp4`);
  const srtPath = path.join(jobDir, `clipe_${index}.srt`);

  // gerar legenda .srt só com as palavras dentro do intervalo do trecho
  const palavras = transcript.words.filter(
    (w) => w.start / 1000 >= trecho.inicio && w.end / 1000 <= trecho.fim
  );
  let srt = "";
  palavras.forEach((w, i) => {
    const ini = formatarSrtTime(w.start / 1000 - trecho.inicio);
    const fim = formatarSrtTime(w.end / 1000 - trecho.inicio);
    srt += `${i + 1}\n${ini} --> ${fim}\n${w.text}\n\n`;
  });
  fs.writeFileSync(srtPath, srt);

  const duracao = trecho.fim - trecho.inicio;

  // corta, reformata pra 9:16 (com blur de fundo) e queima a legenda
  const cmd = `ffmpeg -y -ss ${trecho.inicio} -i "${videoPath}" -t ${duracao} -vf "split[bg][fg];[bg]scale=1080:1920,boxblur=20[bg];[fg]scale=1080:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,subtitles=${srtPath}:force_style='FontSize=16,PrimaryColour=&HFFFFFF&,Alignment=2'" -c:v libx264 -preset fast -crf 23 -c:a aac "${outPath}"`;

  await exec(cmd);
  return outPath;
}

function formatarSrtTime(segundos) {
  const h = String(Math.floor(segundos / 3600)).padStart(2, "0");
  const m = String(Math.floor((segundos % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(segundos % 60)).padStart(2, "0");
  const ms = String(Math.floor((segundos % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

// ---------- STEP 5: subir pro Supabase Storage ----------
async function subirParaSupabase(filePath, jobId, index) {
  const fileBuffer = fs.readFileSync(filePath);
  const storagePath = `clipes/${jobId}/clipe_${index}.mp4`;
  const { error } = await supabase.storage
    .from("videos")
    .upload(storagePath, fileBuffer, { contentType: "video/mp4" });
  if (error) throw error;
  const { data } = supabase.storage.from("videos").getPublicUrl(storagePath);
  return data.publicUrl;
}

// ---------- ROTA PRINCIPAL ----------
app.post("/process", async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl)
    return res.status(400).json({ error: "youtubeUrl é obrigatório" });

  const jobId = uuid();
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // atualiza status no Supabase pra o frontend acompanhar
  await supabase
    .from("jobs")
    .insert({ id: jobId, status: "baixando", youtube_url: youtubeUrl });

  // responde na hora com o jobId; processamento continua em background
  res.json({ jobId });

  try {
    const videoPath = await baixarVideo(youtubeUrl, jobDir);
    await supabase
      .from("jobs")
      .update({ status: "transcrevendo" })
      .eq("id", jobId);

    const transcript = await transcrever(videoPath);
    await supabase
      .from("jobs")
      .update({ status: "selecionando_trechos" })
      .eq("id", jobId);

    const trechos = await escolherTrechos(transcript);
    await supabase.from("jobs").update({ status: "cortando" }).eq("id", jobId);

    const clipesUrls = [];
    for (let i = 0; i < trechos.length; i++) {
      const clipePath = await cortarClipe(
        videoPath,
        trechos[i],
        jobDir,
        i,
        transcript
      );
      const url = await subirParaSupabase(clipePath, jobId, i);
      clipesUrls.push({ url, titulo: trechos[i].titulo });
    }

    await supabase
      .from("jobs")
      .update({ status: "concluido", clipes: clipesUrls })
      .eq("id", jobId);

    fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (err) {
    console.error(err);
    await supabase
      .from("jobs")
      .update({ status: "erro", erro: String(err.message || err) })
      .eq("id", jobId);
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

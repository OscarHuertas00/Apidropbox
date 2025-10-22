import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fileUpload from "express-fileupload";
import { Dropbox } from "dropbox";
import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "50mb" }));
app.use(fileUpload({ limits: { fileSize: 100 * 1024 * 1024 }, useTempFiles: false }));

// ===============================
// 🔐 FUNCIÓN: Obtener nuevo access_token automáticamente
// ===============================
async function getDropboxAccessToken() {
  const clientId = process.env.DROPBOX_APP_KEY;
  const clientSecret = process.env.DROPBOX_APP_SECRET;
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await response.json();
  if (!data.access_token) {
    console.error("❌ No se pudo obtener un nuevo access_token de Dropbox:", data);
    throw new Error("Fallo al renovar el token de Dropbox");
  }
  console.log("🔄 Nuevo access_token obtenido correctamente");
  return data.access_token;
}

// ===============================
// 🗂️ Inicializar Dropbox dinámicamente
// ===============================
let dbx;

async function initDropbox() {
  const token = await getDropboxAccessToken();
  dbx = new Dropbox({
    accessToken: token,
    fetch: (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args)),
  });
}

await initDropbox();

// ===============================
// 📧 Configuración del correo
// ===============================
const transporter = nodemailer.createTransport({
  pool: true,
  service: "gmail",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  maxConnections: 3,
  maxMessages: 50,
});

// ===============================
// 🌐 Endpoint de prueba
// ===============================
app.get("/", (req, res) => {
  res.json({ message: "🚀 API Dropbox funcionando correctamente y token automático activo" });
});

// ===============================
// 📤 Subida de archivos a Dropbox
// ===============================
async function uploadFileChunked(dbx, path, data) {
  const chunkSize = 8 * 1024 * 1024;
  let offset = 0;
  let sessionId = null;

  console.log(`📤 Subiendo archivo: ${path} (${(data.length / 1024 / 1024).toFixed(2)} MB)`);

  while (offset < data.length) {
    const chunk = data.slice(offset, offset + chunkSize);

    if (offset === 0) {
      const response = await dbx.filesUploadSessionStart({ contents: chunk });
      sessionId = response.result.session_id;
    } else if (offset + chunkSize < data.length) {
      await dbx.filesUploadSessionAppendV2({
        cursor: { session_id: sessionId, offset },
        contents: chunk,
      });
    } else {
      await dbx.filesUploadSessionFinish({
        cursor: { session_id: sessionId, offset },
        commit: { path, mode: "add", autorename: true, mute: true },
        contents: chunk,
      });
    }

    offset += chunkSize;
    console.log(`  ├─ Progreso: ${Math.min(((offset / data.length) * 100).toFixed(1), 100)}%`);
  }

  console.log(`✅ Subida completada: ${path}`);
}

// ===============================
// 📥 Endpoint principal para subir formularios
// ===============================
app.post("/api/upload", async (req, res) => {
  try {
    req.setTimeout(10 * 60 * 1000);

    const { nombre, correo, cedula, ciudad, asunto } = req.body;
    const files = req.files?.files;

    if (!files) return res.status(400).json({ ok: false, error: "No se enviaron archivos" });

    const radicado = uuidv4().split("-")[0];
    const carpeta = `/formularios/${radicado}`;

    // Crear carpeta
    await dbx.filesCreateFolderV2({ path: carpeta });

    const fileArray = Array.isArray(files) ? files : [files];
    const maxConcurrent = 4;
    const queue = [...fileArray];
    const active = [];

    const uploadNext = async () => {
      if (queue.length === 0) return;
      const file = queue.shift();
      const promise = uploadFileChunked(dbx, `${carpeta}/${file.name}`, file.data)
        .finally(() => {
          active.splice(active.indexOf(promise), 1);
          uploadNext();
        });
      active.push(promise);
      if (active.length < maxConcurrent) uploadNext();
      return promise;
    };

    const uploads = Array.from({ length: Math.min(maxConcurrent, fileArray.length) }, uploadNext);
    await Promise.all(uploads);

    // Enviar correos
    const correoAdmin = {
      from: process.env.FROM_EMAIL,
      to: process.env.ADMIN_EMAIL,
      subject: `Nuevo formulario recibido - ${radicado}`,
      text: `Se recibió un nuevo formulario:\nNombre: ${nombre}\nCorreo: ${correo}\nCédula: ${cedula}\nCiudad: ${ciudad}\nAsunto: ${asunto}\nRadicado: ${radicado}`,
    };

    const correoUsuario = {
      from: process.env.FROM_EMAIL,
      to: correo,
      subject: `Tu solicitud fue recibida - Radicado ${radicado}`,
      text: `Hola ${nombre},\n\nTu solicitud ha sido radicada con el número ${radicado}.\n\nGracias por comunicarte.`,
    };

    await Promise.all([
      transporter.sendMail(correoAdmin),
      transporter.sendMail(correoUsuario),
    ]);

    res.json({ ok: true, message: "Formulario enviado correctamente ✅", radicado });
  } catch (error) {
    console.error("❌ Error general:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===============================
// 🔊 Iniciar servidor
// ===============================
app.listen(PORT, () => console.log(`✅ API corriendo en puerto ${PORT}`));

export default app;

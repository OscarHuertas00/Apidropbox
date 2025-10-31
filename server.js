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

// ===============================
// ⚙️ CONFIGURACIÓN GENERAL
// ===============================
app.set("trust proxy", 1);
app.use(cors({
  origin: "*", // 🔓 Permitir todas las solicitudes (puedes cambiar "*" por tu dominio)
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "50mb" }));
app.use(fileUpload({
  limits: { fileSize: 100 * 1024 * 1024 },
  useTempFiles: false,
}));

// ===============================
// 🔐 OBTENER ACCESS TOKEN DE DROPBOX
// ===============================
async function getDropboxAccessToken() {
  const clientId = process.env.DROPBOX_APP_KEY;
  const clientSecret = process.env.DROPBOX_APP_SECRET;
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
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
// 🗂️ INICIALIZAR DROPBOX
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
// 📧 CONFIGURAR CORREO
// ===============================
const transporter = nodemailer.createTransport({
  pool: true,
  service: "gmail",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  maxConnections: 3,
  maxMessages: 50,
});

// ===============================
// 🌐 ENDPOINT DE PRUEBA
// ===============================
app.get("/", (req, res) => {
  res.json({ message: "🚀 API Dropbox funcionando correctamente con CORS habilitado" });
});

// ===============================
// 📤 FUNCIÓN PARA SUBIDA CHUNKED
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
// 📥 ENDPOINT PRINCIPAL (SUBIDA)
// ===============================
app.post("/api/upload", async (req, res) => {
  try {
    req.setTimeout(10 * 60 * 1000);

    const { nombre, correo, cedula, ciudad, asunto } = req.body;
    const files = req.files?.files;

    if (!files) {
      return res.status(400).json({ ok: false, error: "No se enviaron archivos" });
    }

    const radicado = uuidv4().split("-")[0];
    const carpeta = `/formularios/${radicado}`;

    // Crear carpeta
    await dbx.filesCreateFolderV2({ path: carpeta });

    // Subir archivos
    const fileArray = Array.isArray(files) ? files : [files];
    const uploads = fileArray.map((f) => uploadFileChunked(dbx, `${carpeta}/${f.name}`, f.data));
    await Promise.all(uploads);

    // Enviar correos
    const correoAdmin = {
      from: process.env.FROM_EMAIL,
      to: process.env.ADMIN_EMAIL,
      subject: `Nuevo formulario recibido - ${radicado}`,
      text: `Nuevo formulario recibido:\n\nNombre: ${nombre}\nCorreo: ${correo}\nCédula: ${cedula}\nCiudad: ${ciudad}\nAsunto: ${asunto}\nRadicado: ${radicado}`,
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
// 🚀 INICIAR SERVIDOR
// ===============================
app.listen(PORT, () => console.log(`✅ API corriendo en puerto ${PORT}`));

export default app;

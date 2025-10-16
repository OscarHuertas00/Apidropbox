import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fileUpload from "express-fileupload";
import { Dropbox } from "dropbox";
import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 🧩 Middlewares
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// 🗂️ Configuración de Dropbox
const dbx = new Dropbox({ accessToken: process.env.DROPBOX_TOKEN });

// 📧 Configuración de correo (Gmail o SMTP)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 🚀 Ruta principal (prueba)
app.get("/", (req, res) => {
  res.json({ message: "API Dropbox funcionando correctamente 🚀" });
});

// 📤 Endpoint para subir archivos y enviar correos
app.post("/api/upload", async (req, res) => {
  try {
    const { nombre, correo, cedula, ciudad, asunto } = req.body;
    const files = req.files?.files;

    if (!files) {
      return res.status(400).json({ ok: false, error: "No se enviaron archivos" });
    }

    // Crear número de radicado
    const radicado = uuidv4().split("-")[0];
    const carpeta = `/formularios/${radicado}`;

    // Crear carpeta en Dropbox
    await dbx.filesCreateFolderV2({ path: carpeta });

    // Subir uno o varios archivos
    const fileArray = Array.isArray(files) ? files : [files];

    for (const file of fileArray) {
      await dbx.filesUpload({
        path: `${carpeta}/${file.name}`,
        contents: file.data,
      });
    }

    // ✉️ Enviar correo al administrador
    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: process.env.ADMIN_EMAIL,
      subject: `Nuevo formulario recibido - ${radicado}`,
      text: `Se recibió un nuevo formulario:\n
Nombre: ${nombre}\nCorreo: ${correo}\nCédula: ${cedula}\nCiudad: ${ciudad}\nAsunto: ${asunto}\nRadicado: ${radicado}`,
    });

    // ✉️ Enviar correo de confirmación al usuario
    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: correo,
      subject: `Tu solicitud fue recibida - Radicado ${radicado}`,
      text: `Hola ${nombre},\n\nTu solicitud ha sido radicada con el número ${radicado}.\nRecibirás una respuesta en un plazo máximo de 5 días hábiles.\n\nGracias.`,
    });

    // ✅ Respuesta al cliente
    res.json({ ok: true, message: "Formulario enviado correctamente ✅", radicado });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 🔊 Iniciar servidor (solo local, Vercel lo ignora)
app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));

export default app;

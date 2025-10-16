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

// Middlewares
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// Dropbox SDK
const dbx = new Dropbox({ accessToken: process.env.DROPBOX_TOKEN });

// Configurar Gmail
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Endpoint principal
app.post("/api/upload", async (req, res) => {
  try {
    const { nombre, correo, cedula, ciudad, asunto } = req.body;
    const files = req.files?.files;
    if (!files) {
      return res.status(400).json({ ok: false, error: "No se enviaron archivos" });
    }

    const radicado = uuidv4().split("-")[0];
    const carpeta = `/formularios/${radicado}`;

    // Crear carpeta en Dropbox
    await dbx.filesCreateFolderV2({ path: carpeta });

    // Manejar uno o varios archivos
    const fileArray = Array.isArray(files) ? files : [files];
    for (const file of fileArray) {
      await dbx.filesUpload({
        path: `${carpeta}/${file.name}`,
        contents: file.data, // el archivo en memoria
      });
    }

    // Correo al administrador
    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: process.env.ADMIN_EMAIL,
      subject: `Nuevo formulario recibido - ${radicado}`,
      text: `Se recibió un nuevo formulario:\n
Nombre: ${nombre}\nCorreo: ${correo}\nCédula: ${cedula}\nCiudad: ${ciudad}\nAsunto: ${asunto}\nRadicado: ${radicado}`,
    });

    // Correo al usuario
    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: correo,
      subject: `Tu solicitud fue recibida - Radicado ${radicado}`,
      text: `Hola ${nombre},\n\nTu solicitud ha sido radicada con el número ${radicado}.\nRecibirás una respuesta en un plazo máximo de 5 días hábiles.\n\nGracias.`,
    });

    res.json({ ok: true, message: "Formulario enviado correctamente ✅", radicado });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/", (req, res) => {
  res.json({ message: "API Dropbox sin almacenamiento funcionando 🚀" });
});

app.listen(PORT, () => console.log(`✅ Servidor en http://localhost:${PORT}`));

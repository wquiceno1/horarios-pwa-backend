import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, "data", "notifications.json");
const serviceAccountPath = path.join(__dirname, "firebase-service-account.json");

let messaging;

try {
    let serviceAccount;
    
    // 1. Intentar cargar desde variable de entorno (Producción/Railway)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log("Cargando credenciales desde variable de entorno...");
        } catch (e) {
            console.error("Error parseando FIREBASE_SERVICE_ACCOUNT:", e);
        }
    }
    
    // 2. Si no hay variable, intentar cargar archivo local (Desarrollo)
    if (!serviceAccount && fs.existsSync(serviceAccountPath)) {
        serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
        console.log("Cargando credenciales desde archivo local...");
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        messaging = admin.messaging();
        console.log("Firebase Admin inicializado correctamente.");
    } else {
        console.warn("ADVERTENCIA: No se encontraron credenciales (ni ENV ni archivo). El envío fallará.");
    }
} catch (error) {
    console.error("Error inicializando Firebase Admin:", error);
}

// --- Utilidades de JSON (sync y simples para MVP) ---
function loadData() {
    try {
        if (!fs.existsSync(DATA_PATH)) {
            // Asegurar que el directorio existe
            const dir = path.dirname(DATA_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Crear archivo por defecto
            const defaultData = { devices: [], notifications: [] };
            fs.writeFileSync(DATA_PATH, JSON.stringify(defaultData, null, 2), "utf8");
            return defaultData;
        }
        const raw = fs.readFileSync(DATA_PATH, "utf8");
        return JSON.parse(raw);
    } catch (err) {
        console.error("Error leyendo JSON, usando estructura vacía:", err);
        return {
            devices: [],
            notifications: []
        };
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

// --- Express app ---
const app = express();
const PORT = process.env.PORT || 3000;

// Configuración CORS explícita
const whitelist = [
    "http://localhost:3000",
    "http://127.0.0.1:5500", // VS Code Live Server
    "https://wquiceno1.github.io" // GitHub Pages
];

const corsOptions = {
    origin: function (origin, callback) {
        // Permitir peticiones sin origen (como apps móviles o curl)
        if (!origin) return callback(null, true);
        
        if (whitelist.indexOf(origin) !== -1 || origin.includes("github.io")) {
            callback(null, true);
        } else {
            console.warn("Bloqueado por CORS:", origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Habilitar pre-flight explícito
app.use(express.json());

// Healthcheck simple
app.get("/api/health", (req, res) => {
    res.json({
        ok: true
    });
});

// POST /api/save-token
// body: { token: string, userAgent?: string }
app.post("/api/save-token", (req, res) => {
    const { token, userAgent } = req.body;

    if (!token) {
        return res.status(400).json({ error: "Token es obligatorio" });
    }

    const data = loadData();
    
    // Verificar si ya existe
    const existingIndex = data.devices.findIndex(d => d.token === token);
    
    if (existingIndex >= 0) {
        // Actualizar timestamp
        data.devices[existingIndex].updatedAt = new Date().toISOString();
        if (userAgent) data.devices[existingIndex].userAgent = userAgent;
        console.log("Token actualizado:", token.substring(0, 20) + "...");
    } else {
        // Nuevo dispositivo
        data.devices.push({
            token,
            userAgent: userAgent || "unknown",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        console.log("Nuevo token guardado:", token.substring(0, 20) + "...");
    }

    saveData(data);
    res.json({ ok: true, message: "Token guardado correctamente" });
});

// POST /api/test-notification
// body: { fcmToken: string, title?: string, body?: string }
app.post("/api/test-notification", async (req, res) => {
    const {
        fcmToken,
        title,
        body
    } = req.body;

    if (!fcmToken) {
        return res.status(400).json({
            error: "fcmToken es obligatorio"
        });
    }

    if (!messaging) {
        return res.status(503).json({
            error: "El servicio de notificaciones no está configurado (falta service-account)."
        });
    }

    const message = {
        token: fcmToken,
        notification: {
            title: title || "Prueba Horarios PWA",
            body: body || "Notificación de prueba desde el backend"
        }
    };

    try {
        const response = await messaging.send(message);
        console.log("Notificación enviada:", response);
        res.json({
            ok: true,
            response
        });
    } catch (err) {
        console.error("Error enviando notificación:", err);
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


// Arrancar servidor
app.listen(PORT, () => {
    console.log(`Backend horarios-pwa-backend escuchando en puerto ${PORT}`);
});
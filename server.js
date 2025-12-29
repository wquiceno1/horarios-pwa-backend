import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { getTodaySchedule } from "./scheduleController.js";

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

// GET /api/schedule/today
// Devuelve el horario calculado para el día actual
app.get("/api/schedule/today", (req, res) => {
    try {
        const schedule = getTodaySchedule();
        res.json({ ok: true, data: schedule });
    } catch (error) {
        console.error("Error obteniendo horario:", error);
        res.status(500).json({ ok: false, error: "Error interno calculando horario" });
    }
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

// GET /api/debug/send-last
// Envía notificación al dispositivo más recientemente actualizado
app.get("/api/debug/send-last", async (req, res) => {
    if (!messaging) {
        return res.status(503).json({ error: "Firebase no inicializado" });
    }
    
    const data = loadData();
    if (!data.devices || data.devices.length === 0) {
        return res.status(404).json({ error: "No hay dispositivos registrados" });
    }

    // Buscar el más reciente
    const lastDevice = data.devices.sort((a, b) => 
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )[0];

    const message = {
        token: lastDevice.token,
        notification: {
            title: "Prueba de Integración",
            body: `Hola! Esta notificación confirma que el flujo Backend -> Firebase -> PWA funciona. Hora: ${new Date().toLocaleTimeString()}`
        }
    };

    try {
        const response = await messaging.send(message);
        console.log("Notificación enviada a último dispositivo:", response);
        res.json({ ok: true, messageId: response, target: lastDevice.token.substring(0, 10) + "..." });
    } catch (err) {
        console.error("Error enviando:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});


// --- CRON JOB / INTERVALO PARA NOTIFICACIONES ---
// Chequear cada minuto eventos de horario
const PRE_NOTIFICATION_MINUTES = 10;
// Cargar timezone de configuración o usar default
const TIMEZONE = "America/Bogota"; 

setInterval(() => {
    checkAndNotify();
}, 60 * 1000); // Cada 60 segundos

async function checkAndNotify() {
    if (!messaging) return;

    try {
        // 1. Obtener hora local
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: TIMEZONE,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        });
        
        const parts = formatter.formatToParts(now);
        const hour = parseInt(parts.find(p => p.type === 'hour').value);
        const minute = parseInt(parts.find(p => p.type === 'minute').value);
        
        // Convertir hora actual a minutos del día
        const currentMinutes = hour * 60 + minute;

        // 2. Obtener horario
        const schedule = getTodaySchedule();
        if (!schedule || !schedule.blocks) return;

        // 3. Revisar bloques
        schedule.blocks.forEach(async (block, index) => {
            const [startH, startM] = block.start.split(':').map(Number);
            const [endH, endM] = block.end.split(':').map(Number);
            
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;
            
            const isFirstBlock = index === 0;
            
            // Helper formato 12h
            const format12h = (h, m) => {
                const ampm = h >= 12 ? 'PM' : 'AM';
                const hour12 = h % 12 || 12;
                return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
            };
            
            const startTime12 = format12h(startH, startM);
            const endTime12 = format12h(endH, endM);

            // --- EVENTOS DE INICIO ---
            
            // A. Notificación Previa (10 min antes de iniciar)
            if (startMinutes - currentMinutes === PRE_NOTIFICATION_MINUTES) {
                console.log(`⏰ Pre-aviso inicio: ${block.entity}`);
                await sendBroadcast(
                    `Próximo turno: ${block.entity}`,
                    `En ${PRE_NOTIFICATION_MINUTES} min inicia labores en ${block.entity} (${startTime12})`
                );
            }

            // B. Notificación de Inicio (Hora exacta)
            if (startMinutes - currentMinutes === 0) {
                console.log(`⏰ Inicio turno: ${block.entity}`);
                const title = isFirstBlock ? "☀️ ¡Buen día! Inicio de Jornada" : `▶️ Inicia turno: ${block.entity}`;
                await sendBroadcast(
                    title,
                    `Es hora de comenzar en ${block.entity} (${startTime12})`
                );
            }

            // --- EVENTOS DE FIN ---

            // C. Notificación Previa (10 min antes de finalizar)
            if (endMinutes - currentMinutes === PRE_NOTIFICATION_MINUTES) {
                console.log(`⏰ Pre-aviso fin: ${block.entity}`);
                await sendBroadcast(
                    `Por finalizar: ${block.entity}`,
                    `En ${PRE_NOTIFICATION_MINUTES} min termina el bloque de ${block.entity}`
                );
            }

            // D. Notificación de Fin (Hora exacta)
            if (endMinutes - currentMinutes === 0) {
                console.log(`⏰ Fin turno: ${block.entity}`);
                await sendBroadcast(
                    `⏹️ Finaliza turno: ${block.entity}`,
                    `Has completado el bloque de ${block.entity} (${endTime12})`
                );
            }
        });

    } catch (err) {
        console.error("Error en checkAndNotify:", err);
    }
}

async function sendBroadcast(title, body) {
    const data = loadData();
    const tokens = data.devices.map(d => d.token);
    
    if (tokens.length === 0) return;

    // Filtrar duplicados si los hubiera
    const uniqueTokens = [...new Set(tokens)];
    
    console.log(`Enviando notificación a ${uniqueTokens.length} dispositivos...`);

    const message = {
        notification: { title, body },
        tokens: uniqueTokens
    };

    try {
        const response = await messaging.sendEachForMulticast(message);
        console.log(`${response.successCount} notificaciones enviadas exitosamente.`);
        if (response.failureCount > 0) {
            console.log('Fallaron algunas notificaciones:', response.responses);
        }
    } catch (error) {
        console.error('Error enviando broadcast:', error);
    }
}



// Arrancar servidor
app.listen(PORT, () => {
    console.log(`Backend horarios-pwa-backend escuchando en puerto ${PORT}`);
});
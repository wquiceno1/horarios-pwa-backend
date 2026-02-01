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
let db;

try {
    let serviceAccount;
    
    // 1. Intentar cargar desde variable de entorno (Producción/Railway/Vercel)
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
        // Evitar inicializar múltiples veces
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        messaging = admin.messaging();
        db = admin.firestore();
        console.log("Firebase Admin (Messaging + Firestore) inicializado correctamente.");
    } else {
        console.warn("ADVERTENCIA: No se encontraron credenciales. El envío fallará.");
    }
} catch (error) {
    console.error("Error inicializando Firebase Admin:", error);
}

// --- Express app ---
const app = express();
const PORT = process.env.PORT || 3000;

// Configuración CORS explícita
const whitelist = [
    "http://localhost:3000",
    "http://127.0.0.1:5500", // VS Code Live Server
    "https://wquiceno1.github.io", // GitHub Pages
    "https://horarios-pwa.vercel.app" // Vercel Frontend
];

const corsOptions = {
    origin: function (origin, callback) {
        // Permitir peticiones sin origen (como apps móviles o curl)
        if (!origin) return callback(null, true);
        
        // Permitir whitelist y cualquier subdominio de vercel.app (para previews)
        if (whitelist.indexOf(origin) !== -1 || origin.includes("github.io") || origin.endsWith(".vercel.app")) {
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
app.post("/api/save-token", async (req, res) => {
    const { token, userAgent } = req.body;

    if (!token) {
        return res.status(400).json({ error: "Token es obligatorio" });
    }

    if (!db) {
        return res.status(503).json({ error: "Base de datos no disponible" });
    }

    try {
        const deviceRef = db.collection('devices').doc(token);
        const doc = await deviceRef.get();
        
        if (doc.exists) {
            await deviceRef.update({ 
                updatedAt: new Date().toISOString(),
                userAgent: userAgent || doc.data().userAgent 
            });
            console.log("Token actualizado (Firestore):", token.substring(0, 20) + "...");
        } else {
            await deviceRef.set({
                token,
                userAgent: userAgent || "unknown",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            console.log("Nuevo token guardado (Firestore):", token.substring(0, 20) + "...");
        }

        res.json({ ok: true, message: "Token guardado correctamente" });
    } catch (error) {
        console.error("Error guardando token en Firestore:", error);
        res.status(500).json({ error: "Error guardando token" });
    }
});

// POST /api/check-token
// Verifica si un token ya existe en la BD
app.post("/api/check-token", async (req, res) => {
    const { token } = req.body;
    if (!token || !db) return res.status(400).json({ ok: false });

    try {
        const doc = await db.collection('devices').doc(token).get();
        if (doc.exists) {
            res.json({ ok: true, exists: true });
        } else {
            res.json({ ok: true, exists: false });
        }
    } catch (err) {
        console.error("Error verificando token:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
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
        },
        android: {
            priority: "high",
            notification: {
                priority: "max",
                defaultSound: true
            }
        },
        webpush: {
            headers: {
                Urgency: "high"
            }
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

// POST /api/debug/broadcast
// Envía una notificación de prueba a TODOS los dispositivos
app.post("/api/debug/broadcast", async (req, res) => {
    const { title, body } = req.body;
    
    console.log("Iniciando Broadcast Manual...");
    
    try {
        await sendBroadcast(
            title || "🔔 Prueba General",
            body || "Esta es una prueba enviada a todos los dispositivos registrados."
        );
        res.json({ ok: true, message: "Broadcast enviado" });
    } catch (err) {
        console.error("Error en broadcast manual:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/debug/send-last
// Envía notificación al dispositivo más recientemente actualizado
app.get("/api/debug/send-last", async (req, res) => {
    if (!messaging || !db) {
        return res.status(503).json({ error: "Firebase no inicializado" });
    }
    
    try {
        const snapshot = await db.collection('devices')
            .orderBy('updatedAt', 'desc')
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.status(404).json({ error: "No hay dispositivos registrados" });
        }

        const lastDevice = snapshot.docs[0].data();

        const message = {
            token: lastDevice.token,
            notification: {
                title: "Prueba de Integración",
                body: `Hola! Esta notificación confirma que el flujo Backend -> Firebase -> PWA funciona. Hora: ${new Date().toLocaleTimeString()}`
            }
        };

        const response = await messaging.send(message);
        console.log("Notificación enviada a último dispositivo:", response);
        res.json({ ok: true, messageId: response, target: lastDevice.token.substring(0, 10) + "..." });
    } catch (err) {
        console.error("Error enviando:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/debug/devices
// Ver lista de dispositivos registrados
app.get("/api/debug/devices", async (req, res) => {
    if (!db) return res.status(503).json({ error: "DB no disponible" });
    
    try {
        const snapshot = await db.collection('devices').get();
        const devices = snapshot.docs.map(doc => doc.data());
        
        res.json({
            ok: true,
            count: devices.length,
            devices: devices.map(d => ({
                userAgent: d.userAgent,
                updatedAt: d.updatedAt,
                tokenPrefix: d.token.substring(0, 10) + "..."
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// DELETE /api/debug/devices
// Borra todos los dispositivos registrados (para reiniciar pruebas)
app.delete("/api/debug/devices", async (req, res) => {
    if (!db) return res.status(503).json({ error: "DB no disponible" });

    try {
        const snapshot = await db.collection('devices').get();
        
        if (snapshot.empty) {
            return res.json({ ok: true, message: "No había dispositivos para borrar." });
        }

        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });

        await batch.commit();
        console.log(`Purgados ${snapshot.size} dispositivos.`);
        
        res.json({ ok: true, message: `Se eliminaron ${snapshot.size} dispositivos.` });
    } catch (error) {
        console.error("Error purgando dispositivos:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- CRON JOB (Vercel) ---
// Chequear cada minuto eventos de horario.
// Vercel llamará a este endpoint.
const PRE_NOTIFICATION_MINUTES = 10;
const TIMEZONE = "America/Bogota"; 

app.get("/api/cron", async (req, res) => {
    // Validar autorización si es necesario (ej: header secreto)
    // if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) { ... }
    
    console.log("Ejecutando CRON JOB...");
    await checkAndNotify();
    res.json({ ok: true, timestamp: new Date().toISOString() });
});

async function checkAndNotify() {
    if (!messaging) return;

    try {
        // 1. Obtener hora local y día de la semana
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: TIMEZONE,
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'long',
            hour12: false
        });
        
        const parts = formatter.formatToParts(now);
        const hour = parseInt(parts.find(p => p.type === 'hour').value);
        const minute = parseInt(parts.find(p => p.type === 'minute').value);
        const weekday = parts.find(p => p.type === 'weekday').value;

        // Validar fin de semana (No enviar notificaciones sábados ni domingos)
        if (weekday === 'Saturday' || weekday === 'Sunday') {
            console.log("Fin de semana, saltando notificaciones.");
            return;
        }
        
        // Convertir hora actual a minutos del día
        const currentMinutes = hour * 60 + minute;

        // 2. Obtener horario
        const schedule = getTodaySchedule();
        if (!schedule || !schedule.blocks) return;

        console.log(`Chequeando horario ${hour}:${minute} (${currentMinutes} min) - ${schedule.blocks.length} bloques`);

        // 3. Revisar bloques
        // Usamos for...of para poder usar await correctamente si fuera necesario
        for (const [index, block] of schedule.blocks.entries()) {
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
        }

    } catch (err) {
        console.error("Error en checkAndNotify:", err);
    }
}

async function sendBroadcast(title, body) {
    if (!db) return;

    try {
        const snapshot = await db.collection('devices').get();
        const tokens = snapshot.docs.map(doc => doc.data().token);
        
        if (tokens.length === 0) return;

        // Filtrar duplicados si los hubiera
        const uniqueTokens = [...new Set(tokens)];
        
        console.log(`Enviando notificación a ${uniqueTokens.length} dispositivos...`);
    
        const message = {
            notification: { title, body },
            tokens: uniqueTokens
        };
    
        const response = await messaging.sendEachForMulticast(message);
        console.log(`${response.successCount} notificaciones enviadas exitosamente.`);
        if (response.failureCount > 0) {
            console.log('Fallaron algunas notificaciones:', response.responses);
        }
    } catch (error) {
        console.error('Error enviando broadcast:', error);
    }
}



// Arrancar servidor solo si no estamos en Vercel (o para desarrollo local)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Backend horarios-pwa-backend escuchando en puerto ${PORT}`);
    });
}

// Exportar para Vercel
export default app;
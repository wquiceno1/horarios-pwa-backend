import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEDULES_PATH = path.join(__dirname, 'data', 'schedules.json');

let cachedSchedules = null;

// Cargar horarios (con caché simple)
function getSchedules() {
    if (cachedSchedules) return cachedSchedules;
    try {
        const raw = fs.readFileSync(SCHEDULES_PATH, 'utf8');
        cachedSchedules = JSON.parse(raw);
        return cachedSchedules;
    } catch (error) {
        console.error("Error cargando schedules.json:", error);
        return null;
    }
}

// Calcular fecha del "N-ésimo día X del mes" (Ej: Primer sábado de Septiembre)
function getNthWeekdayOfMonth(year, month, weekday, n) {
    // month: 1-12, weekday: 0 (Sun) - 6 (Sat)
    const date = new Date(year, month - 1, 1);
    let count = 0;
    
    // Avanzar hasta encontrar el primer día que coincida
    while (date.getMonth() === month - 1) {
        if (date.getDay() === weekday) {
            count++;
            if (count === n) {
                return new Date(date); // Encontrado
            }
        }
        date.setDate(date.getDate() + 1);
    }
    return null;
}

// Determinar qué temporada aplica hoy
function getCurrentSeason() {
    const data = getSchedules();
    if (!data) return null;

    const today = new Date();
    const currentYear = today.getFullYear();
    const config = data.config.seasons.summer_chile;

    // Calcular inicio y fin del horario de verano para este año
    // Regla: Verano Chile empieza en Septiembre y termina en Abril del SIGUIENTE año.
    
    // Si estamos en la segunda mitad del año (Sept-Dic), miramos el inicio de ESTE año.
    // Si estamos en la primera mitad (Ene-Abril), el verano empezó el año ANTERIOR.
    
    let seasonStart, seasonEnd;
    
    if (today.getMonth() + 1 >= 9) {
        // Estamos a finales de año (ej: Nov 2024). Verano empezó Sept 2024.
        seasonStart = getNthWeekdayOfMonth(currentYear, config.rule_start.month, config.rule_start.weekday, config.rule_start.occurrence);
        seasonEnd = getNthWeekdayOfMonth(currentYear + 1, config.rule_end.month, config.rule_end.weekday, config.rule_end.occurrence);
    } else {
        // Estamos a principios de año (ej: Feb 2025). Verano empezó Sept 2024.
        seasonStart = getNthWeekdayOfMonth(currentYear - 1, config.rule_start.month, config.rule_start.weekday, config.rule_start.occurrence);
        seasonEnd = getNthWeekdayOfMonth(currentYear, config.rule_end.month, config.rule_end.weekday, config.rule_end.occurrence);
    }

    // Normalizar fechas para comparar (sin horas)
    const todayTime = today.setHours(0,0,0,0);
    const startTime = seasonStart.setHours(0,0,0,0);
    const endTime = seasonEnd.setHours(0,0,0,0);

    // Si hoy está DENTRO del rango de verano
    if (todayTime >= startTime && todayTime < endTime) {
        return "summer_chile";
    } else {
        return "winter_chile";
    }
}

// Obtener el horario para el día de hoy
export function getTodaySchedule() {
    const data = getSchedules();
    if (!data) return { error: "No configuration loaded" };

    const seasonKey = getCurrentSeason();
    const seasonConfig = data.schedules[seasonKey];
    const seasonInfo = data.config.seasons[seasonKey];

    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado

    let blocks = [];
    let dayType = "";

    if (dayOfWeek >= 1 && dayOfWeek <= 4) {
        dayType = "monday_to_thursday";
        blocks = seasonConfig.monday_to_thursday;
    } else if (dayOfWeek === 5) {
        dayType = "friday";
        blocks = seasonConfig.friday;
    } else {
        dayType = "weekend";
        blocks = []; // Fin de semana libre
    }

    return {
        date: today.toLocaleDateString("es-CO"),
        season: {
            key: seasonKey,
            name: seasonInfo.name,
            description: seasonInfo.description
        },
        dayType: dayType,
        blocks: blocks
    };
}

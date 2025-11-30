import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import cors from 'cors';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, existsSync } from 'fs';
import dotenv from 'dotenv';

// ==================== СИСТЕМА УПРАВЛЕНИЯ ПРОЦЕССАМИ ====================
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ✅ УЛУЧШЕННАЯ СИСТЕМА ЗАЩИТЫ ОТ ДУБЛИРОВАНИЯ
const pendingTransactions = new Map();
const completedTransactions = new Map(); // Кэш завершенных операций

// ✅ ИСПРАВЛЕННАЯ ФУНКЦИЯ БЕЗОПАСНЫХ ОПЕРАЦИЙ
async function safeSparksOperation(userId, operationType, operationId, callback) {
    const transactionKey = `${userId}_${operationType}_${operationId}`;
    
    // Проверяем, не выполняется ли уже эта операция
    if (pendingTransactions.has(transactionKey)) {
        throw new Error('Операция уже выполняется');
    }
    
    // Проверяем, не была ли операция уже завершена (TTL 5 минут)
    const completedOp = completedTransactions.get(transactionKey);
    if (completedOp && (Date.now() - completedOp.timestamp) < 5 * 60 * 1000) {
        console.log('⚠️ Операция уже была выполнена ранее:', transactionKey);
        return completedOp.result;
    }
    
    try {
        // Помечаем операцию как выполняющуюся
        pendingTransactions.set(transactionKey, {
            timestamp: Date.now(),
            userId,
            operationType,
            operationId
        }); // ← УБРАЛ ЛИШНЮЮ ТОЧКУ С ЗАПЯТОЙ
        
        // Выполняем callback функцию
        const result = await callback();
        
        // Сохраняем в кэш завершенных операций
        completedTransactions.set(transactionKey, {
            timestamp: Date.now(),
            result: result
        });
        
        // Очищаем старые записи (старше 5 минут)
        cleanupCompletedTransactions();
        
        return result;
    } finally {
        // Всегда снимаем блокировку
        pendingTransactions.delete(transactionKey);
    }
}

// Очистка старых записей
function cleanupCompletedTransactions() {
    const now = Date.now();
    for (const [key, value] of completedTransactions.entries()) {
        if (now - value.timestamp > 5 * 60 * 1000) { // 5 минут
            completedTransactions.delete(key);
        }
    }
}
// ✅ УПРОЩЕННАЯ ФУНКЦИЯ НАЧИСЛЕНИЯ/СПИСАНИЯ ИСКР
function addSparks(userId, sparks, activityType, description) {
    const user = db.users.find(u => u.user_id == userId);
    if (!user) {
        console.error('❌ Пользователь не найден для начисления искр:', userId);
        return;
    }
    
    // Сохраняем старое значение для лога
    const oldSparks = user.sparks;
    
    // ПРОВЕРКА БАЛАНСА ПРИ СПИСАНИИ
    if (sparks < 0 && user.sparks < Math.abs(sparks)) {
        console.error(`❌ Недостаточно искр. Нужно: ${Math.abs(sparks)}✨, у вас: ${user.sparks}✨`);
        return;
    }
    
    // ВЫЧИСЛЯЕМ НОВОЕ ЗНАЧЕНИЕ
    const newSparks = Number((user.sparks + sparks).toFixed(1));
    user.sparks = newSparks;
    user.level = calculateLevel(user.sparks);
    user.last_active = new Date().toISOString();
    
    // СОЗДАЕМ ЗАПИСЬ АКТИВНОСТИ
    const activity = {
        id: Date.now(),
        user_id: userId,
        activity_type: activityType,
        sparks_earned: sparks,
        description: description,
        old_balance: oldSparks,
        new_balance: user.sparks,
        created_at: new Date().toISOString()
    };
    
    db.activities.push(activity);
    
    console.log(`💰 ОПЕРАЦИЯ С ИСКРАМИ: ${description}`);
    console.log(`   Пользователь: ${userId} (${user.tg_first_name})`);
    console.log(`   Изменение: ${sparks > 0 ? '+' : ''}${sparks}✨`);
    console.log(`   Баланс: ${oldSparks} → ${user.sparks}✨`);
    console.log(`   Уровень: ${user.level}`);
}
// ✅ ТЕПЕРЬ ИНИЦИАЛИЗИРУЕМ EXPRESS APP
const app = express();

// Функция для освобождения порта и управления процессами
async function setupProcessManagement() {
    const pidFile = join(__dirname, 'server.pid');
    const PORT = process.env.PORT || 3000;
    
    try {
        // Пытаемся убить процессы на том же порту
        console.log('🔍 Проверка занятости порта...');
        
        // Для Linux/Mac
        try {
            const { stdout } = await execAsync(`lsof -ti:${PORT}`);
            if (stdout.trim()) {
                const pids = stdout.trim().split('\n');
                console.log(`🔄 Найденные процессы на порту ${PORT}: ${pids.join(', ')}`);
                
                for (const pid of pids) {
                    try {
                        await execAsync(`kill -9 ${pid}`);
                        console.log(`✅ Процесс ${pid} завершен`);
                    } catch (killError) {
                        console.log(`⚠️ Не удалось завершить процесс ${pid}`);
                    }
                }
            }
        } catch (error) {
            // Порту свободен или команда не сработала
            console.log('✅ Порт свободен или ОС Windows');
        }
        
        // Для Windows (если нужно)
        try {
            const { stdout } = await execAsync(`netstat -ano | findstr :${PORT}`);
            if (stdout) {
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const match = line.match(/\s+(\d+)$/);
                    if (match) {
                        const pid = match[1];
                        console.log(`🔄 Найден процесс Windows PID: ${pid}`);
                        await execAsync(`taskkill /PID ${pid} /F`);
                        console.log(`✅ Процесс Windows ${pid} завершен`);
                    }
                }
            }
        } catch (error) {
            // Не Windows или порт свободен
        }
        
        // Сохраняем PID текущего процесса
        const fs = await import('fs');
        fs.writeFileSync(pidFile, process.pid.toString());
        console.log(`📝 PID текущего процесса сохранен: ${process.pid}`);
        
    } catch (error) {
        console.log('⚠️ Ошибка управления процессами:', error.message);
    }
}

// Обработка graceful shutdown
function setupGracefulShutdown() {
    const pidFile = join(__dirname, 'server.pid');
    
    const shutdownHandlers = {
        'SIGINT': 'Ctrl+C',
        'SIGTERM': 'системный сигнал завершения',
        'SIGUSR2': 'перезапуск nodemon',
        'uncaughtException': 'необработанное исключение',
        'unhandledRejection': 'необработанный промис'
    };
    
    Object.keys(shutdownHandlers).forEach(signal => {
        process.on(signal, async (err) => {
            console.log(`\n🔄 Получен ${shutdownHandlers[signal]} (${signal})`);
            
            if (err) {
                console.error('❌ Ошибка:', err);
            }
            
            try {
                // Удаляем PID файл
                const fs = await import('fs');
                if (fs.existsSync(pidFile)) {
                    fs.unlinkSync(pidFile);
                    console.log('✅ PID файл удален');
                }
                
                console.log('👋 Сервер корректно завершает работу...');
                
                if (server) {
                    server.close(() => {
                        console.log('✅ HTTP сервер остановлен');
                        process.exit(signal === 'uncaughtException' ? 1 : 0);
                    });
                    
                    // Таймаут на случай если сервер не закрывается
                    setTimeout(() => {
                        console.log('⚠️ Принудительное завершение');
                        process.exit(1);
                    }, 5000);
                } else {
                    process.exit(signal === 'uncaughtException' ? 1 : 0);
                }
            } catch (cleanupError) {
                console.error('❌ Ошибка при завершении:', cleanupError);
                process.exit(1);
            }
        });
    });
    
    console.log('✅ Обработчики graceful shutdown установлены');
}

// Автоматическое определение пути для TimeWeb
const APP_ROOT = process.cwd();

console.log('🎨 Мастерская Вдохновения - Запуск системы...');
console.log('📁 Текущая рабочая директория:', APP_ROOT);

// ==================== ПРОДАКШЕН БАЗА ДАННЫХ ====================
let db = {
    users: [], // Начинаем с пустого массива - реальные пользователи
    roles: [
        {
            id: 1,
            name: 'Художники',
            description: 'Творцы изобразительного искусства',
            icon: '🎨',
            available_buttons: ['quiz', 'marathon', 'works', 'activities', 'posts', 'shop', 'invite', 'interactives', 'change_role'],
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 2,
            name: 'Стилисты',
            description: 'Мастера создания образов',
            icon: '👗',
            available_buttons: ['quiz', 'marathon', 'works', 'activities', 'posts', 'shop', 'invite', 'interactives', 'change_role'],
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 3,
            name: 'Мастера',
            description: 'Ремесленники прикладного искусства',
            icon: '🧵',
            available_buttons: ['quiz', 'marathon', 'works', 'activities', 'posts', 'shop', 'invite', 'interactives', 'change_role'],
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 4,
            name: 'Историки',
            description: 'Знатоки истории искусств',
            icon: '🏛️',
            available_buttons: ['quiz', 'marathon', 'works', 'activities', 'posts', 'shop', 'invite', 'interactives', 'change_role'],
            is_active: true,
            created_at: new Date().toISOString()
        }
    ],
    characters: [
        { 
            id: 1, 
            role_id: 1, 
            name: 'Лука Цветной', 
            description: 'Рисует с детства, любит эксперименты с цветом', 
            bonus_type: 'percent_bonus', 
            bonus_value: '10', 
            is_active: true,
            created_at: new Date().toISOString()
        },
        { 
            id: 2, 
            role_id: 1, 
            name: 'Марина Кисть', 
            description: 'Строгая преподавательница академической живописи', 
            bonus_type: 'forgiveness', 
            bonus_value: '1', 
            is_active: true,
            created_at: new Date().toISOString()
        },
        { 
            id: 3, 
            role_id: 2, 
            name: 'Эстелла Моде', 
            description: 'Бывший стилист, обучает восприятию образа', 
            bonus_type: 'percent_bonus', 
            bonus_value: '5', 
            is_active: true,
            created_at: new Date().toISOString()
        },
        { 
            id: 4, 
            role_id: 3, 
            name: 'Артем Резчик', 
            description: 'Мастер по дереву и керамике', 
            bonus_type: 'random_gift', 
            bonus_value: '1-3', 
            is_active: true,
            created_at: new Date().toISOString()
        },
        { 
            id: 5, 
            role_id: 4, 
            name: 'София Хроник', 
            description: 'Искусствовед и историк культуры', 
            bonus_type: 'secret_advice', 
            bonus_value: '2weeks', 
            is_active: true,
            created_at: new Date().toISOString()
        }
    ],
    
    quizzes: [
        {
            id: 1,
            title: "🎨 Основы живописи",
            description: "Проверьте свои знания основ живописи",
            questions: [
                {
                    question: "Кто написал картину 'Мона Лиза'?",
                    options: ["Винсент Ван Гог", "Леонардо да Винчи", "Пабло Пикассо", "Клод Моне"],
                    correctAnswer: 1
                },
                {
                    question: "Какие цвета являются основными?",
                    options: ["Красный, синий, зеленый", "Красный, желтый, синий", "Фиолетовый, оранжевый, зеленый", "Черный, белый, серый"],
                    correctAnswer: 1
                },
                {
                    question: "Что такое акварель?",
                    options: ["Масляная краска", "Водорастворимая краска", "Акриловая краска", "Темпера"],
                    correctAnswer: 1
                },
                {
                    question: "Кто является автором 'Крика'?",
                    options: ["Винсент Ван Гог", "Эдвард Мунк", "Сальвадор Дали", "Фрида Кало"],
                    correctAnswer: 1
                },
                {
                    question: "Что такое сфумато?",
                    options: ["Техника резких контрастов", "Техника мягких переходов", "Техника точечного нанесения", "Техника ярких цветов"],
                    correctAnswer: 1
                }
            ],
            sparks_per_correct: 1,
            sparks_perfect_bonus: 5,
            cooldown_hours: 24,
            allow_retake: true,
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 2,
            title: "🏛️ История искусства",
            description: "Тест по истории мирового искусства",
            questions: [
                {
                    question: "В какой стране возникло искусство эпохи Возрождения?",
                    options: ["Франция", "Италия", "Испания", "Германия"],
                    correctAnswer: 1
                },
                {
                    question: "Кто является автором фрески 'Тайная вечеря'?",
                    options: ["Микеланджело", "Рафаэль", "Леонардо да Винчи", "Боттичелли"],
                    correctAnswer: 2
                },
                {
                    question: "Какой стиль характеризуется асимметрией и изогнутыми линиями?",
                    options: ["Ренессанс", "Барокко", "Готика", "Классицизм"],
                    correctAnswer: 1
                }
            ],
            sparks_per_correct: 1,
            sparks_perfect_bonus: 5,
            cooldown_hours: 24,
            allow_retake: true,
            is_active: true,
            created_at: new Date().toISOString()
        }
    ],
    marathons: [
        {
            id: 1,
            title: "🏃‍♂️ Марафон акварели",
            description: "7-дневный марафон по основам акварельной живописи",
            duration_days: 7,
            tasks: [
                { 
                    day: 1, 
                    title: "Основные техники", 
                    description: "Изучите основные техники работы с акварелью и напишите о своих впечатлениях",
                    requires_submission: true,
                    submission_type: "text"
                },
                { 
                    day: 2, 
                    title: "Смешивание цветов", 
                    description: "Практикуйтесь в смешивании цветов и загрузите фото своей палитры",
                    requires_submission: true,
                    submission_type: "image"
                },
                { 
                    day: 3, 
                    title: "Работа с светом", 
                    description: "Научитесь передавать свет и тень в акварели",
                    requires_submission: true,
                    submission_type: "text"
                },
                { 
                    day: 4, 
                    title: "Пейзаж акварелью", 
                    description: "Нарисуйте свой первый пейзаж и загрузите фото работы",
                    requires_submission: true,
                    submission_type: "image"
                },
                { 
                    day: 5, 
                    title: "Портрет акварелью", 
                    description: "Освойте технику портрета акварелью",
                    requires_submission: true,
                    submission_type: "text"
                },
                { 
                    day: 6, 
                    title: "Натюрморт", 
                    description: "Создайте композицию с натуры и загрузите фото",
                    requires_submission: true,
                    submission_type: "image"
                },
                { 
                    day: 7, 
                    title: "Финальная работа", 
                    description: "Завершите марафон итоговой работой и поделитесь впечатлениями",
                    requires_submission: true,
                    submission_type: "text"
                }
            ],
            sparks_per_day: 7,
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 2,
            title: "👗 Марафон стиля",
            description: "5-дневный марафон по созданию гармоничного образа",
            duration_days: 5,
            tasks: [
                { 
                    day: 1, 
                    title: "Анализ цветотипа", 
                    description: "Определите свой цветотип и опишите результаты",
                    requires_submission: true,
                    submission_type: "text"
                },
                { 
                    day: 2, 
                    title: "Базовая капсула", 
                    description: "Создайте базовый гардероб и загрузите фото своих вещей",
                    requires_submission: true,
                    submission_type: "image"
                },
                { 
                    day: 3, 
                    title: "Акценты и аксессуары", 
                    description: "Научитесь дополнять образ аксессуарами",
                    requires_submission: true,
                    submission_type: "text"
                },
                { 
                    day: 4, 
                    title: "Стилизация", 
                    description: "Создайте несколько образов и загрузите фото",
                    requires_submission: true,
                    submission_type: "image"
                },
                { 
                    day: 5, 
                    title: "Итоговый образ", 
                    description: "Подберите идеальный образ для мероприятия и опишите его",
                    requires_submission: true,
                    submission_type: "text"
                }
            ],
            sparks_per_day: 5,
            is_active: true,
            created_at: new Date().toISOString()
        }
    ],
    shop_items: [
        {
            id: 1,
            title: "🎨 Урок акварели для начинающих",
            description: "Полный видеоурок по основам акварельной живописи",
            type: "video",
            file_url: "https://example.com/watercolor-course.mp4",
            preview_url: "https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=300&h=200&fit=crop",
            price: 15,
            content_text: "В этом уроке вы научитесь основам работы с акварелью, смешиванию цветов и созданию первых работ. Материал подойдет для начинающих художников.\n\nСодержание:\n- Подготовка материалов\n- Основные техники\n- Смешивание цветов\n- Создание простых работ\n- Советы по улучшению",
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 2,
            title: "📚 Основы композиции",
            description: "PDF руководство по основам композиции в живописи",
            type: "pdf",
            file_url: "https://example.com/composition-guide.pdf",
            preview_url: "https://images.unsplash.com/photo-1513475382585-d06e58bcb0e0?w=300&h=200&fit=crop",
            price: 10,
            content_text: "Подробное руководство по построению композиции в художественных работах. Золотое сечение, правило третей, баланс и ритм.\n\nТемы:\n- Золотое сечение\n- Правило третей\n- Баланс и симметрия\n- Создание глубины\n- Работа с цветом",
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 3,
            title: "👗 Гид по стилю",
            description: "Полное руководство по созданию гармоничного образа",
            type: "text",
            file_url: "",
            preview_url: "https://images.unsplash.com/photo-1445205170230-053b83016050?w=300&h=200&fit=crop",
            price: 12,
            content_text: "Как определить свой цветотип, подобрать базовый гардероб, сочетать цвета и аксессуары. Практические советы от стилиста.\n\nРазделы:\n- Определение цветотипа\n- Базовый гардероб\n- Сочетание цветов\n- Выбор аксессуаров\n- Создание образов",
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 4,
            title: "🧵 Основы вышивки",
            description: "Видеокурс по основам вышивки для начинающих",
            type: "video",
            file_url: "https://example.com/embroidery-course.mp4",
            preview_url: "https://images.unsplash.com/photo-1576588676125-c6d68cf48b5c?w=300&h=200&fit=crop",
            price: 18,
            content_text: "Полный курс по основам вышивки. От простых стежков до сложных техник.\n\nСодержание:\n- Необходимые материалы\n- Основные стежки\n- Техники вышивки\n- Создание узоров\n- Завершение работы",
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 5,
            title: "🎬 Видео-урок по композиции",
            description: "Эксклюзивный видео-урок по основам композиции от профессионального художника",
            type: "embed",
            embed_html: `<div style="padding:56.25% 0 0 0;position:relative;"><iframe src="https://player.vimeo.com/video/1139315921?h=93d70dfee4&amp;badge=0&amp;autopause=0&amp;player_id=0&amp;app_id=58479" frameborder="0" allow="autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share" referrerpolicy="strict-origin-when-cross-origin" style="position:absolute;top:0;left:0;width:100%;height:100%;" title="ТИХОНОВА"></iframe></div><script src="https://player.vimeo.com/api/player.js"></script>`,
            preview_url: "https://images.unsplash.com/photo-1492684223066-81332ee5ff30?w=300&h=200&fit=crop",
            price: 20,
            content_text: "Профессиональный видео-урок по основам композиции в живописи. Вы научитесь правильно располагать элементы на холсте, создавать гармоничные композиции и направлять взгляд зрителя.\n\nТемы урока:\n- Золотое сечение\n- Правило третей\n- Баланс и симметрия\n- Создание глубины\n- Работа с акцентами",
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 6,
            title: "📺 Тестовое видео",
            description: "Простой тест embed-видео",
            type: "embed",
            embed_html: `<div style="width: 100%; height: 400px; background: #f0f0f0; display: flex; align-items: center; justify-content: center; border-radius: 12px;">
                <div style="text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 16px;">🎬</div>
                    <div style="font-size: 18px; font-weight: bold; margin-bottom: 8px;">Тестовое видео</div>
                    <div style="color: #666;">Здесь будет встроенное видео</div>
                </div>
            </div>`,
            preview_url: "",
            price: 5,
            content_text: "Это тестовый embed-контент для проверки отображения",
            is_active: true,
            created_at: new Date().toISOString()
        }  
    ],
    activities: [],
    admins: [
        { 
            id: 1, 
            user_id: 898508164, 
            username: 'admin', 
            role: 'admins', 
            created_at: new Date().toISOString() 
        },
        { 
            id: 2, 
            user_id: 79156202620, 
            username: 'admin2', 
            role: 'admins', 
            created_at: new Date().toISOString() 
        },
        { 
            id: 3, 
            user_id: 781959267, 
            username: 'admin3', 
            role: 'admins', 
            created_at: new Date().toISOString() 
        }
    ],
    purchases: [],
    channel_posts: [
        {
            id: 1,
            post_id: "post_art_basics",
            title: "🎨 Основы композиции в живописи",
            content: "Сегодня поговорим о фундаментальных принципах построения композиции. Золотое сечение, правило третей и многое другое! Композиция - это основа любого художественного произведения, которая помогает направлять взгляд зрителя и создавать гармоничное изображение.\n\n💡 Практический совет: Попробуйте использовать правило третей в своей следующей работе - разделите холст на 9 равных частей и размещайте ключевые элементы на пересечениях линий.",
            image_url: "https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=400&h=300&fit=crop",
            video_url: null,
            media_type: 'image',
            admin_id: 898508164,
            is_active: true,
            created_at: new Date().toISOString(),
            telegram_message_id: null,
            action_type: null,
            action_target: null
        },
        {
            id: 2,
            post_id: "post_style_tips",
            title: "👗 5 советов по созданию стильного образа",
            content: "1. Определите свой цветотип\n2. Создайте базовую капсулу\n3. Не бойтесь аксессуаров\n4. Учитывайте мероприятие\n5. Будьте уверены в себе!\n\n✨ Помните: Стиль - это не следование трендам, а умение выражать свою индивидуальность через одежду.",
            image_url: "https://images.unsplash.com/photo-1445205170230-053b83016050?w=400&h=300&fit=crop",
            video_url: null,
            media_type: 'image',
            admin_id: 898508164,
            is_active: true,
            created_at: new Date().toISOString(),
            telegram_message_id: null,
            action_type: null,
            action_target: null
        },
        {
            id: 3,
            post_id: "post_history_art",
            title: "🏛️ Интересные факты о Ренессансе",
            content: "Эпоха Возрождения подарила миру множество шедевров. Знаете ли вы, что:\n\n• Леонардо да Винчи был вегетарианцем\n• Микеланджело считал себя в первую очередь скульптором\n• Рафаэль умер в день своего рождения\n• Боттичелли сжег многие свои работы\n\n🎯 Интересный факт: Картины того времени часто содержали скрытые символы и послания.",
            image_url: "https://images.unsplash.com/photo-1513475382585-d06e58bcb0e0?w=400&h=300&fit=crop",
            video_url: null,
            media_type: 'image',
            admin_id: 898508164,
            is_active: true,
            created_at: new Date().toISOString(),
            telegram_message_id: null,
            action_type: null,
            action_target: null
        }
    ],
    post_reviews: [],
    user_works: [],
    work_reviews: [],
    marathon_completions: [],
    quiz_completions: [],
    daily_reviews: [],
    interactives: [
        {
            id: 1,
            title: "🎨 Угадай эпоху картины",
            description: "Определите эпоху по фрагменту картины",
            type: "guess_era",
            category: "history",
            image_url: "https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=400&h=300&fit=crop",
            question: "Какой эпохе принадлежит этот фрагмент?",
            options: ["Ренессанс", "Барокко", "Импрессионизм", "Кубизм"],
            correct_answer: 0,
            sparks_reward: 3,
            allow_retake: false,
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 2,
            title: "👗 Подбери образ для мероприятия",
            description: "Создай гармоничный образ для конкретного события",
            type: "style_match",
            category: "style",
            image_url: "https://images.unsplash.com/photo-1445205170230-053b83016050?w=400&h=300&fit=crop",
            question: "Какое сочетание цветов подойдет для деловой встречи?",
            options: ["Черный + белый + красный акцент", "Ярко-красный + зеленый", "Фиолетовый + оранжевый", "Розовый + голубой"],
            correct_answer: 0,
            sparks_reward: 2,
            allow_retake: true,
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 3,
            title: "✏️ Продолжи рисунок",
            description: "Дорисуйте предложенный контур и создайте свою работу",
            type: "drawing_challenge",
            category: "art",
            image_url: "https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=400&h=300&fit=crop",
            question: "Дорисуйте этот контур и создайте свою уникальную работу",
            options: [],
            correct_answer: null,
            sparks_reward: 5,
            allow_retake: true,
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 4,
            title: "🔍 Найди отличия",
            description: "Найдите все отличия между двумя изображениями",
            type: "find_difference",
            category: "art",
            image_url: "https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=400&h=300&fit=crop",
            question: "Сколько отличий вы нашли между изображениями?",
            options: ["2 отличия", "3 отличия", "4 отличия", "5 отличий"],
            correct_answer: 2,
            sparks_reward: 3,
            allow_retake: false,
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 5,
            title: "🧩 Исторический пазл",
            description: "Соберите пазл из фрагментов известной картины",
            type: "puzzle",
            category: "history",
            image_url: "https://images.unsplash.com/photo-1513475382585-d06e58bcb0e0?w=400&h=300&fit=crop",
            question: "Из скольких фрагментов состоит этот пазл?",
            options: ["6 фрагментов", "9 фрагментов", "12 фрагментов", "16 фрагментов"],
            correct_answer: 1,
            sparks_reward: 2,
            allow_retake: true,
            is_active: true,
            created_at: new Date().toISOString()
        },
        {
            id: 6,
            title: "🎭 Определи стиль художника",
            description: "По фрагменту картины определите авторский стиль",
            type: "guess_era",
            category: "history",
            image_url: "https://images.unsplash.com/photo-1578301978693-85fa9c0320b9?w=400&h=300&fit=crop",
            question: "Какому художнику принадлежит этот стиль?",
            options: ["Ван Гог", "Моне", "Пикассо", "Дали"],
            correct_answer: 0,
            sparks_reward: 4,
            allow_retake: false,
            is_active: true,
            created_at: new Date().toISOString()
        }
    ],
    interactive_completions: [],
    interactive_submissions: [],
// В объекте db добавьте эти коллекции если их нет:
private_channel_videos: [
    {
        id: 1,
        invite_link: "https://t.me/+INVITE_LINK_123",
        title: "🎬 Профессиональный урок по акварели",
        description: "Полный урок по технике акварельной живописи от профессионального художника",
        duration: "45 минут",
        price: 25,
        category: "video",
        level: "intermediate",
        is_active: true,
        created_at: new Date().toISOString()
    },
    {
        id: 2,
        invite_link: "https://t.me/+INVITE_LINK_456",
        title: "🎨 Мастер-класс по портрету", 
        description: "Учимся рисовать портреты с нуля до профессионального уровня",
        duration: "60 минут",
        price: 30,
        category: "video",
        level: "intermediate",
        is_active: true,
        created_at: new Date().toISOString()
    }
],
video_access: [],
marathon_submissions: []
};

// Функция для безопасного выполнения fetch запросов
async function safeFetch(url, options = {}) {
    try {
        const response = await fetch(url, {
            timeout: 10000,
            ...options
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('❌ Ошибка сети:', error);
        throw error;
    }
}

// Обновите функцию loadUserData
async function loadUserData() {
    try {
        console.log('🔄 Загрузка данных пользователя:', currentUserId);
        
        const data = await safeFetch(`/api/users/${currentUserId}`);
        
        if (data.exists) {
            currentUser = data.user;
            showUserData();
            loadAvailableButtons();
        } else {
            showWelcomeScreen();
        }
        
    } catch (error) {
        console.error('❌ Ошибка загрузки пользователя:', error);
        
        // Fallback - создаем тестового пользователя
        console.log('🔄 Используем тестового пользователя');
        currentUser = {
            user_id: currentUserId,
            tg_first_name: 'Тестовый Пользователь',
            sparks: 45.5,
            level: 'Искатель',
            is_registered: true,
            class: 'Художники',
            character_name: 'Лука Цветной'
        };
        
        showUserData();
        loadAvailableButtons();
    }
}

// Проверка доступности сервера
async function checkServerHealth() {
    try {
        const response = await fetch('/api/test', { timeout: 5000 });
        return response.ok;
    } catch (error) {
        console.error('❌ Сервер недоступен:', error);
        return false;
    }
}

// Обновите инициализацию
async function initApp() {
    try {
        console.log('🚀 Инициализация приложения...');
        
        // Проверяем сервер
        const serverHealthy = await checkServerHealth();
        if (!serverHealthy) {
            showErrorState('Сервер временно недоступен. Используем демо-режим.');
            // Продолжаем в демо-режиме
        }
        
        // ... остальной код инициализации
    } catch (error) {
        console.error('💥 Ошибка инициализации:', error);
        showErrorState('Ошибка загрузки приложения');
    }
}

// ==================== ТЕЛЕГРАМ АВТОМАТИЗАЦИЯ ====================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;


// Функция для создания инвайт-ссылки для канала
async function createChannelInviteLink(channelId) {
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: channelId,
                creates_join_request: true // Требует одобрения
            })
        });
        
        const result = await response.json();
        return result.ok ? 
            { success: true, invite_link: result.result.invite_link } : 
            { success: false, error: result.description };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Увеличены лимиты для больших файлов (3GB)
app.use(express.json({ limit: '3gb' }));
app.use(express.urlencoded({ limit: '3gb', extended: true }));
app.use(cors());

// Дополнительные настройки для body-parser (если используется)
app.use(bodyParser.json({ limit: '3gb' }));
app.use(bodyParser.urlencoded({ limit: '3gb', extended: true }));


// ==================== СТАТИЧЕСКИЕ ФАЙЛЫ ====================
app.use(express.static(join(APP_ROOT, 'public'), { maxAge: '1d' }));

// Правильная настройка для админ-панели
app.use('/admin', express.static(join(APP_ROOT, 'public'), { maxAge: '1d' }));

app.get('/admin', (req, res) => {
    res.sendFile(join(APP_ROOT, 'public', 'admin.html'));
});

app.get('/admin/*', (req, res) => {
    // Перенаправляем все админ-запросы на admin.html
    if (!req.path.includes('.')) { // Если это не файл (css, js, etc)
        res.sendFile(join(APP_ROOT, 'public', 'admin.html'));
    } else {
        // Для статических файлов используем основной public
        const filePath = req.path.replace('/admin/', '');
        res.sendFile(join(APP_ROOT, 'public', filePath));
    }
});

// ==================== НАСТРОЙКИ ДЛЯ БОЛЬШИХ ФАЙЛОВ ====================

// Middleware для увеличения лимитов и таймаутов
app.use((req, res, next) => {
    // Увеличиваем таймауты для больших файлов (30 минут)
    req.setTimeout(30 * 60 * 1000); // 30 минут
    res.setTimeout(30 * 60 * 1000); // 30 минут
    console.log(`⏰ Установлены таймауты для ${req.method} ${req.url}`);
    next();
});

// Обработка ошибок больших файлов
app.use((error, req, res, next) => {
    if (error.code === 'LIMIT_FILE_SIZE') {
        console.error('❌ Файл слишком большой:', error.message);
        return res.status(413).json({ 
            success: false,
            error: 'Файл слишком большой. Максимальный размер: 3GB' 
        });
    }
    
    if (error.type === 'entity.too.large') {
        console.error('❌ Превышен лимит размера файла:', error.message);
        return res.status(413).json({ 
            success: false,
            error: 'Превышен лимит размера файла. Максимальный размер: 3GB' 
        });
    }
    
    console.error('❌ Неизвестная ошибка:', error);
    next(error);
});

// Глобальный обработчик ошибок для больших файлов
process.on('uncaughtException', (error) => {
    if (error.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED') {
        console.error('❌ Превышен максимальный размер тела запроса');
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанное отклонение промиса:', reason);
});

// УЛУЧШЕННАЯ СИСТЕМА НАЧИСЛЕНИЯ ИСКР
const SPARKS_SYSTEM = {
    QUIZ_PER_CORRECT_ANSWER: 1,
    QUIZ_PERFECT_BONUS: 5,
    MARATHON_DAY_COMPLETION: 7,
    INVITE_FRIEND: 10,
    WRITE_REVIEW: 3,
    DAILY_COMMENT: 1,
    UPLOAD_WORK: 5,
    WORK_APPROVED: 15,
    REGISTRATION_BONUS: 10,
    PARTICIPATE_POLL: 2,
    INTERACTIVE_COMPLETION: 3,
    INTERACTIVE_SUBMISSION: 2,
    COMPLIMENT_CHALLENGE: 0.5,
    MARATHON_SUBMISSION: 5,
    ROLE_CHANGE: 0
};

// Вспомогательные функции
function calculateLevel(sparks) {
    if (sparks >= 400) return 'Наставник';
    if (sparks >= 300) return 'Мастер';
    if (sparks >= 150) return 'Знаток';
    if (sparks >= 50) return 'Искатель';
    return 'Ученик';
}

function getUserStats(userId) {
    const user = db.users.find(u => u.user_id == userId);
    if (!user) return null;
    
    const activities = db.activities.filter(a => a.user_id == userId);
    const purchases = db.purchases.filter(p => p.user_id == userId);
    const works = db.user_works.filter(w => w.user_id == userId);
    const quizCompletions = db.quiz_completions.filter(q => q.user_id == userId);
    const marathonCompletions = db.marathon_completions.filter(m => m.user_id == userId);
    const interactiveCompletions = db.interactive_completions.filter(i => i.user_id == userId);
    
    return {
        totalActivities: activities.length,
        totalPurchases: purchases.length,
        totalWorks: works.length,
        approvedWorks: works.filter(w => w.status === 'approved').length,
        totalQuizzesCompleted: quizCompletions.length,
        totalMarathonsCompleted: marathonCompletions.filter(m => m.completed).length,
        totalInteractivesCompleted: interactiveCompletions.length,
        totalSparksEarned: activities.reduce((sum, a) => sum + a.sparks_earned, 0)
    };
}

// Middleware - ИСПРАВЛЕННАЯ ВЕРСИЯ
const requireAdmin = (req, res, next) => {
    const userId = req.query.userId || req.body.userId;
    
    console.log('🔐 Проверка админских прав для пользователя:', userId);
    
    if (!userId) {
        return res.status(401).json({ error: 'User ID required' });
    }
    
    // ПРОСТАЯ ПРОВЕРКА - ВСЕ, У КОГО ЕСТЬ ID, МОГУТ ВОЙТИ В АДМИНКУ
    const admin = db.admins.find(a => a.user_id == userId);
    if (!admin) {
        console.log('⚠️ Пользователь не найден в списке админов, но разрешаем доступ');
        // Разрешаем доступ всем для тестирования
        req.admin = { user_id: userId, role: 'admin' };
        return next();
    }
    
    req.admin = admin;
    next();
};

// Basic routes
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        version: '7.0.0',
        database: 'In-Memory',
        users: db.users.length,
        quizzes: db.quizzes.length,
        marathons: db.marathons.length,
        shop_items: db.shop_items.length,
        interactives: db.interactives.length
    });
});

// Проверка подписки пользователя на канал
async function checkTelegramSubscription(userId, channelId) {
    try {
        // Используем Telegram Bot API для проверки подписки
        const chatMember = await telegramBot.getChatMember(channelId, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        console.error('Ошибка проверки подписки:', error);
        return false;
    }
}

// Получение или создание пригласительной ссылки
async function getOrCreateInviteLink(videoId, userId) {
    try {
        // Проверяем есть ли активная ссылка в базе
        const existingLink = await getActiveInviteLink(videoId);
        if (existingLink) {
            return existingLink;
        }
        
        // Создаем новую ссылку
        const video = await getPrivateVideoById(videoId);
        const inviteLink = await telegramBot.createChatInviteLink(video.channel_id, {
            member_limit: 1,
            expire_date: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 часа
        });
        
        // Сохраняем в базу
        await saveInviteLink(videoId, inviteLink.invite_link, userId);
        
        return inviteLink.invite_link;
        
    } catch (error) {
        console.error('Ошибка создания ссылки:', error);
        throw new Error('Не удалось создать пригласительную ссылку');
    }
}

// Проверка доступа к видео
async function checkVideoAccess(userId, videoId) {
    try {
        // Здесь должна быть реальная проверка из вашей базы данных
        // Временная заглушка - проверяем есть ли покупка
        const purchase = await db.get(`
            SELECT * FROM purchases 
            WHERE user_id = ? AND item_id = ? AND item_type = 'private_video'
        `, [userId, videoId]);
        
        return !!purchase;
    } catch (error) {
        console.error('Ошибка проверки доступа:', error);
        return false;
    }
}

// Получение данных видео
async function getPrivateVideoById(videoId) {
    try {
        // Здесь реальный запрос к вашей базе данных
        const video = await db.get(`
            SELECT * FROM private_videos WHERE id = ?
        `, [videoId]);
        
        return video;
    } catch (error) {
        console.error('Ошибка получения видео:', error);
        return null;
    }
}

// Упрощенная система токенов
function generateVideoToken(userId, videoId) {
    const tokenData = `${userId}|${videoId}|${Date.now()}`;
    return Buffer.from(tokenData).toString('base64url');
}

function validateVideoToken(token, userId, videoId) {
    try {
        const decoded = Buffer.from(token, 'base64url').toString();
        const [tokenUserId, tokenVideoId, timestamp] = decoded.split('|');
        
        // Проверяем соответствие пользователя и видео
        if (parseInt(tokenUserId) !== parseInt(userId) || parseInt(tokenVideoId) !== parseInt(videoId)) {
            return false;
        }
        
        // Проверяем срок действия токена (24 часа)
        const tokenAge = Date.now() - parseInt(timestamp);
        if (tokenAge > 24 * 60 * 60 * 1000) {
            return false;
        }
        
        return true;
    } catch (error) {
        return false;
    }
}


// ==================== ОПТИМИЗИРОВАННЫЕ API ДЛЯ МОБИЛЬНЫХ ====================

// Middleware для определения мобильных устройств
app.use((req, res, next) => {
    const userAgent = req.headers['user-agent'] || '';
    const isMobile = /Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
    req.isMobile = isMobile;
    
    if (isMobile) {
        console.log('📱 Мобильное устройство обнаружено:', userAgent.substring(0, 50));
        // Устанавливаем специальные заголовки для мобильных
        res.set('X-Mobile-Optimized', 'true');
    }
    next();
});

// Оптимизированный API для мобильных с увеличенными таймаутами
app.get('/api/mobile/optimized-data', (req, res) => {
    const userId = parseInt(req.query.userId);
    const isMobile = req.isMobile;
    
    console.log(`📱 Оптимизированный мобильный API запрос от пользователя: ${userId}`);
    
    // Устанавливаем увеличенный таймаут для мобильных
    if (isMobile) {
        req.setTimeout(45000); // 45 секунд
        res.setTimeout(45000);
    }
    
    try {
        const user = db.users.find(u => u.user_id === userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Упрощенные данные для мобильных
        const response = {
            user: {
                id: user.user_id,
                name: user.tg_first_name,
                level: user.level,
                sparks: user.sparks,
                role: user.class,
                character: user.character_name
            },
            // Минимальные данные для быстрой загрузки
            quick_stats: {
                quizzes: db.quizzes.filter(q => q.is_active).length,
                marathons: db.marathons.filter(m => m.is_active).length,
                shop_items: db.shop_items.filter(i => i.is_active).length,
                interactives: db.interactives.filter(i => i.is_active).length
            },
            optimized: true,
            timestamp: new Date().toISOString(),
            timeouts_set: isMobile
        };
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Ошибка оптимизированного API:', error);
        res.status(500).json({ 
            error: 'Mobile API error',
            optimized: true 
        });
    }
});

// Улучшенный endpoint для загрузки тяжелого контента
app.get('/api/mobile/lazy-load', (req, res) => {
    const { type, page = 1, limit = 8 } = req.query;
    const isMobile = req.isMobile;
    
    console.log(`📱 Ленивая загрузка: ${type}, страница ${page}`);
    
    // Устанавливаем увеличенный таймаут
    if (isMobile) {
        req.setTimeout(30000);
        res.setTimeout(30000);
    }
    
    try {
        let content = [];
        const actualLimit = isMobile ? Math.min(limit, 6) : limit;
        const offset = (page - 1) * actualLimit;
        
        switch(type) {
            case 'shop':
                content = db.shop_items
                    .filter(i => i.is_active)
                    .slice(offset, offset + actualLimit)
                    .map(item => ({
                        id: item.id,
                        title: item.title,
                        description: item.description,
                        type: item.type,
                        price: item.price,
                        preview_url: item.preview_url,
                        // Для embed-видео добавляем специальную пометку
                        is_embed: item.type === 'embed'
                    }));
                break;
                
            case 'interactives':
                content = db.interactives
                    .filter(i => i.is_active)
                    .slice(offset, offset + actualLimit)
                    .map(interactive => ({
                        id: interactive.id,
                        title: interactive.title,
                        description: interactive.description,
                        type: interactive.type,
                        category: interactive.category,
                        sparks_reward: interactive.sparks_reward
                    }));
                break;
        }
        
        res.json({
            content,
            page: parseInt(page),
            limit: actualLimit,
            hasMore: content.length === actualLimit,
            optimized: isMobile,
            load_time: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Ошибка ленивой загрузки:', error);
        res.status(500).json({ 
            error: 'Lazy load error',
            optimized: true 
        });
    }
});

// GET /api/webapp/private-videos/:videoId/access
app.get('/api/webapp/private-videos/:videoId/access', async (req, res) => {
    try {
        const { videoId } = req.params;
        const { userId } = req.query;
        
        // Проверяем покупку
        const hasAccess = await checkVideoAccess(userId, videoId);
        if (!hasAccess) {
            return res.json({ success: false, error: 'Доступ к материалу не приобретен' });
        }
        
        // Получаем данные видео
        const video = await getPrivateVideoById(videoId);
        
        // Проверяем подписку пользователя на канал
        const isSubscribed = await checkTelegramSubscription(userId, video.channel_id);
        
        if (isSubscribed) {
            // Пользователь подписан - даем прямой доступ
            const protectedLink = generateProtectedLink(video.channel_id, video.message_id, userId);
            res.json({
                success: true,
                access_type: 'direct_access',
                access_url: protectedLink
            });
        } else {
            // Пользователь не подписан - даем пригласительную ссылку
            const inviteLink = await getOrCreateInviteLink(videoId, userId);
            res.json({
                success: true,
                access_type: 'invite_link',
                access_url: inviteLink,
                message: 'Для доступа к материалу необходимо вступить в канал по пригласительной ссылке'
            });
        }
        
    } catch (error) {
        console.error('Ошибка доступа:', error);
        res.json({ success: false, error: 'Ошибка доступа к материалу' });
    }
});

// POST /api/webapp/private-videos/:videoId/request-invite
app.post('/api/webapp/private-videos/:videoId/request-invite', async (req, res) => {
    try {
        const { videoId } = req.params;
        const { userId } = req.body;
        
        // Проверяем покупку
        const hasAccess = await checkVideoAccess(userId, videoId);
        if (!hasAccess) {
            return res.json({ success: false, error: 'Доступ к материалу не приобретен' });
        }
        
        // Получаем или создаем пригласительную ссылку
        const video = await getPrivateVideoById(videoId);
        const inviteLink = await getOrCreateInviteLink(videoId, userId);
        
        res.json({
            success: true,
            invite_link: inviteLink,
            message: 'Используйте эту ссылку для вступления в канал'
        });
        
    } catch (error) {
        console.error('Ошибка запроса ссылки:', error);
        res.json({ success: false, error: 'Ошибка получения пригласительной ссылки' });
    }
});

// ✅ ИСПРАВЛЕННЫЙ ENDPOINT ДЛЯ ПОКУПКИ ТОВАРА
app.post('/api/webapp/shop/purchase', (req, res) => {
    try {
        const { userId, itemId } = req.body;
        
        console.log('🛒 Запрос на покупку товара:', { userId, itemId });
        
        if (!userId || !itemId) {
            return res.status(400).json({ 
                success: false, 
                error: 'User ID and item ID are required' 
            });
        }

        const user = db.users.find(u => u.user_id == userId);
        const item = db.shop_items.find(i => i.id == itemId && i.is_active);

        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: 'Пользователь не найден' 
            });
        }
        
        if (!item) {
            return res.status(404).json({ 
                success: false, 
                error: 'Товар не найден или неактивен' 
            });
        }

        // Проверяем баланс
        if (user.sparks < item.price) {
            return res.status(400).json({ 
                success: false, 
                error: `Недостаточно искр. Нужно: ${item.price}✨, у вас: ${user.sparks.toFixed(1)}✨`
            });
        }

        // Проверяем, не куплен ли уже товар
        const existingPurchase = db.purchases.find(
            p => p.user_id === userId && 
                 p.item_id === itemId && 
                 p.item_type === 'shop_item'
        );

        if (existingPurchase) {
            return res.status(400).json({ 
                success: false, 
                error: 'У вас уже есть этот товар' 
            });
        }

        // ВСЕ ОПЕРАЦИИ В ОДНОЙ ТРАНЗАКЦИИ
        const oldSparks = user.sparks;
        
        // СПИСЫВАЕМ ИСКРЫ
        user.sparks = Number((user.sparks - item.price).toFixed(1));
        
        // СОЗДАЕМ ЗАПИСЬ О ПОКУПКЕ
        const purchase = {
            id: Date.now(),
            user_id: parseInt(userId),
            item_id: parseInt(itemId),
            item_type: 'shop_item',
            item_title: item.title,
            price_paid: item.price,
            purchased_at: new Date().toISOString()
        };
        db.purchases.push(purchase);

        // ЗАПИСЫВАЕМ АКТИВНОСТЬ СПИСАНИЯ
        const activity = {
            id: Date.now(),
            user_id: userId,
            activity_type: 'shop_purchase',
            sparks_earned: -item.price,
            description: `Покупка товара: ${item.title}`,
            old_balance: oldSparks,
            new_balance: user.sparks,
            created_at: new Date().toISOString()
        };
        db.activities.push(activity);

        console.log(`✅ ПОКУПКА ТОВАРА УСПЕШНА: ${item.title}`);
        console.log(`   Пользователь: ${userId} (${user.tg_first_name})`);
        console.log(`   Списано: ${item.price}✨`);
        console.log(`   Баланс: ${oldSparks} → ${user.sparks}✨`);

        res.json({
            success: true,
            purchase: purchase,
            remaining_sparks: user.sparks,
            message: `✅ "${item.title}" успешно приобретен!`
        });

    } catch (error) {
        console.error('❌ Ошибка покупки товара:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка при покупке товара' 
        });
    }
});
app.post('/api/webapp/private-videos/purchase', async (req, res) => {
    try {
        const { userId, videoId } = req.body;
        
        console.log('🛒 Покупка приватного материала:', { userId, videoId });

        if (!userId || !videoId) {
            return res.status(400).json({ 
                success: false,
                error: 'User ID and video ID are required' 
            });
        }

        const user = db.users.find(u => u.user_id == userId);
        const video = db.private_channel_videos.find(v => v.id == videoId && v.is_active);

        if (!user) {
            return res.status(404).json({ 
                success: false,
                error: 'Пользователь не найден' 
            });
        }
        
        if (!video) {
            return res.status(404).json({ 
                success: false,
                error: 'Материал не найден или неактивен' 
            });
        }

        // Генерируем уникальный ID операции
        const operationId = `video_purchase_${userId}_${videoId}_${Date.now()}`;

        // Проверяем баланс
        if (user.sparks < video.price) {
            return res.status(402).json({ 
                success: false,
                error: `Недостаточно искр. Нужно: ${video.price}✨, у вас: ${user.sparks.toFixed(1)}✨` 
            });
        }

        // Проверяем, не куплен ли уже материал
        const existingPurchase = db.purchases.find(p => 
            p.user_id == userId && 
            p.item_id == videoId && 
            p.item_type === 'private_video'
        );

        if (existingPurchase) {
            return res.status(409).json({ 
                success: false,
                error: 'У вас уже есть доступ к этому материалу' 
            });
        }

        // ВСЕ ОПЕРАЦИИ В ОДНОЙ БЕЗОПАСНОЙ ТРАНЗАКЦИИ
        const result = await safeSparksOperation(userId, 'video_purchase', operationId, () => {
            // 1. Списание искр
            const oldSparks = user.sparks;
            user.sparks = Number((user.sparks - video.price).toFixed(1));
            
            // 2. Создание записи о покупке
            const purchase = {
                id: Date.now(),
                user_id: parseInt(userId),
                item_id: parseInt(videoId),
                item_type: 'private_video',
                item_title: video.title,
                price_paid: video.price,
                operation_id: operationId,
                purchased_at: new Date().toISOString()
            };
            db.purchases.push(purchase);

            // 3. Запись активности списания
            const activity = {
                id: Date.now(),
                user_id: userId,
                activity_type: 'private_video_purchase',
                sparks_earned: -video.price,
                description: `Покупка доступа к материалу: ${video.title}`,
                operation_id: operationId,
                old_balance: oldSparks,
                new_balance: user.sparks,
                created_at: new Date().toISOString()
            };
            db.activities.push(activity);

            console.log(`✅ ПОКУПКА МАТЕРИАЛА УСПЕШНА: ${video.title}`);
            console.log(`   Пользователь: ${userId}`);
            console.log(`   Списано: ${video.price}✨`);
            console.log(`   Баланс: ${oldSparks} → ${user.sparks}✨`);
            console.log(`   ID операции: ${operationId}`);

            return { purchase, activity, remainingSparks: user.sparks };
        });

        res.json({
            success: true,
            purchase: result.purchase,
            remaining_sparks: result.remainingSparks,
            invite_link: video.invite_link,
            message: `✅ Доступ к "${video.title}" успешно приобретен! Нажмите "Перейти к материалу" для вступления в канал.`
        });

    } catch (error) {
        console.error('❌ Ошибка покупки приватного материала:', error);
        res.status(500).json({ 
            success: false,
            error: error.message === 'Операция уже выполняется' 
                ? 'Покупка уже обрабатывается' 
                : 'Ошибка при покупке доступа к материалу' 
        });
    }
});

// Endpoint для отладки - проверка состояния доступа
app.get('/api/webapp/debug/video-access', (req, res) => {
    try {
        const { userId, videoId } = req.query;
        
        const result = {
            video_access: db.video_access,
            purchases: db.purchases.filter(p => p.item_type === 'private_video'),
            user_access: db.video_access.filter(a => a.user_id == userId),
            user_purchases: db.purchases.filter(p => p.user_id == userId && p.item_type === 'private_video'),
            specific_access: db.video_access.filter(a => a.user_id == userId && a.video_id == videoId)
        };
        
        res.json(result);
    } catch (error) {
        console.error('❌ Ошибка отладки:', error);
        res.status(500).json({ error: 'Ошибка отладки' });
    }
});


// ✅ ENDPOINT ДЛЯ ПОЛУЧЕНИЯ ИНВАЙТ-ССЫЛКИ
app.get('/api/webapp/private-videos/:videoId/invite', async (req, res) => {
    try {
        const videoId = parseInt(req.params.videoId);
        const userId = parseInt(req.query.userId);
        
        console.log('🔗 Запрос инвайт-ссылки:', { videoId, userId });

        // Простая проверка покупки
        const hasPurchase = db.purchases.some(purchase => 
            purchase.user_id == userId && 
            purchase.item_id == videoId && 
            purchase.item_type === 'private_video'
        );
        
        if (!hasPurchase) {
            return res.json({ 
                success: false, 
                error: 'Для получения ссылки необходимо сначала приобрести материал' 
            });
        }
        
        const video = db.private_channel_videos.find(v => v.id === videoId && v.is_active);
        if (!video) {
            return res.json({ success: false, error: 'Материал не найден' });
        }
        
        console.log('✅ Покупка подтверждена, возвращаем инвайт-ссылку:', video.invite_link);
        
        res.json({
            success: true,
            invite_link: video.invite_link,
            video_title: video.title,
            message: 'Нажмите "Перейти к материалу" для вступления в канал'
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения приглашения:', error);
        res.json({ 
            success: false, 
            error: 'Не удалось получить ссылку' 
        });
    }
});

// Получение доступа к купленному материалу
app.get('/api/webapp/private-videos/:videoId/access', async (req, res) => {
    try {
        const { videoId } = req.params;
        const { userId } = req.query;
        
        // Проверяем покупку
        const purchase = await db.get(
            `SELECT p.*, v.title, v.channel_id, v.message_id 
             FROM private_video_purchases p
             JOIN private_videos v ON p.video_id = v.id
             WHERE p.user_id = ? AND p.video_id = ? AND p.access_granted = 1`,
            [userId, videoId]
        );
        
        if (!purchase) {
            return res.json({ 
                success: false, 
                error: 'Доступ к материалу не найден или не оплачен' 
            });
        }
        
        // Проверяем, что пользователь все еще в канале
        const memberCheck = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChatMember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: purchase.channel_id,
                user_id: userId
            })
        });
        
        const checkResult = await memberCheck.json();
        const isMember = checkResult.ok && ['member', 'administrator', 'creator'].includes(checkResult.result.status);
        
        if (!isMember) {
            // Пытаемся добавить снова
            const addResult = await addUserToChannel(userId, purchase.channel_id);
            if (!addResult.success) {
                return res.json({ 
                    success: false, 
                    error: 'Вы не являетесь участником канала. Обратитесь к администратору.' 
                });
            }
        }
        
        // Создаем прямую ссылку на пост
        const postUrl = `https://t.me/c/${purchase.channel_id.toString().replace('-100', '')}/${purchase.message_id}`;
        
        // Обновляем счетчик просмотров
        await db.run(
            'UPDATE private_video_purchases SET view_count = view_count + 1 WHERE id = ?',
            [purchase.id]
        );
        
        res.json({
            success: true,
            access_type: 'direct_link',
            post_url: postUrl,
            video_title: purchase.title,
            message: 'Открываем материал...'
        });
        
    } catch (error) {
        console.error('Ошибка доступа к приватному видео:', error);
        res.json({ success: false, error: 'Ошибка доступа' });
    }
});

// Получение списка купленных материалов
app.get('/api/webapp/users/:userId/purchased-private-videos', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const purchases = await db.all(
            `SELECT p.*, v.title, v.description, v.duration, v.category, v.level,
                    v.channel_id, v.message_id, v.price as original_price
             FROM private_video_purchases p
             JOIN private_videos v ON p.video_id = v.id
             WHERE p.user_id = ? AND p.access_granted = 1
             ORDER BY p.purchased_at DESC`,
            [userId]
        );
        
        res.json({
            success: true,
            purchases: purchases || []
        });
        
    } catch (error) {
        console.error('Ошибка загрузки покупок:', error);
        res.json({ success: false, error: 'Ошибка загрузки', purchases: [] });
    }
});

// GET /api/webapp/check-subscription
app.get('/api/webapp/check-subscription', async (req, res) => {
    try {
        const { userId, channelId } = req.query;
        
        // Здесь должна быть реальная проверка подписки через Telegram API
        // Пока возвращаем заглушку
        res.json({
            success: true,
            is_subscribed: false, // По умолчанию false, нужно реализовать проверку
            channel_id: channelId
        });
        
    } catch (error) {
        console.error('Ошибка проверки подписки:', error);
        res.json({ 
            success: true, 
            is_subscribed: false 
        });
    }
});

// Обновление приватного материала
app.put('/api/admin/private-videos/:id', requireAdmin, (req, res) => {
    try {
        const videoId = parseInt(req.params.id);
        const videoIndex = db.private_channel_videos.findIndex(v => v.id === videoId);
        
        if (videoIndex === -1) {
            return res.status(404).json({ 
                success: false, 
                error: 'Материал не найден' 
            });
        }

        const { 
            invite_link, 
            title, 
            description, 
            duration, 
            price, 
            category, 
            level, 
            is_active 
        } = req.body;

        // Обновляем только переданные поля
        if (invite_link !== undefined) db.private_channel_videos[videoIndex].invite_link = invite_link;
        if (title !== undefined) db.private_channel_videos[videoIndex].title = title;
        if (description !== undefined) db.private_channel_videos[videoIndex].description = description;
        if (duration !== undefined) db.private_channel_videos[videoIndex].duration = duration;
        if (price !== undefined) db.private_channel_videos[videoIndex].price = parseFloat(price);
        if (category !== undefined) db.private_channel_videos[videoIndex].category = category;
        if (level !== undefined) db.private_channel_videos[videoIndex].level = level;
        if (is_active !== undefined) db.private_channel_videos[videoIndex].is_active = is_active;

        console.log('✅ Приватный материал обновлен:', db.private_channel_videos[videoIndex].title);

        res.json({
            success: true,
            video: db.private_channel_videos[videoIndex],
            message: 'Материал успешно обновлен'
        });

    } catch (error) {
        console.error('❌ Ошибка обновления приватного видео:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка сервера' 
        });
    }
});



// Удаление приватного материала
app.delete('/api/admin/private-videos/:id', requireAdmin, (req, res) => {
    try {
        const videoId = parseInt(req.params.id);
        const videoIndex = db.private_channel_videos.findIndex(v => v.id === videoId);
        
        if (videoIndex === -1) {
            return res.status(404).json({ 
                success: false, 
                error: 'Материал не найден' 
            });
        }

        const videoTitle = db.private_channel_videos[videoIndex].title;

        // Удаляем видео и связанные доступы
        db.private_channel_videos.splice(videoIndex, 1);
        db.video_access = db.video_access.filter(va => va.video_id !== videoId);
        db.purchases = db.purchases.filter(p => 
            !(p.item_id === videoId && p.item_type === 'private_video')
        );

        console.log('✅ Приватный материал удален:', videoTitle);

        res.json({
            success: true,
            message: 'Материал успешно удален'
        });

    } catch (error) {
        console.error('❌ Ошибка удаления приватного видео:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка сервера' 
        });
    }
});

// Получить статистику приватного материала
app.get('/api/admin/private-videos/:id/stats', requireAdmin, (req, res) => {
    try {
        const videoId = parseInt(req.params.id);
        
        const video = db.private_channel_videos.find(v => v.id === videoId);
        if (!video) {
            return res.status(404).json({ 
                success: false, 
                error: 'Материал не найден' 
            });
        }

        const purchaseCount = db.purchases.filter(p => 
            p.item_id === videoId && p.item_type === 'private_video'
        ).length;

        const accessCount = db.video_access.filter(access => 
            access.video_id === videoId
        ).length;

        const uniqueUsers = [...new Set(db.video_access
            .filter(access => access.video_id === videoId)
            .map(access => access.user_id)
        )].length;

        const totalRevenue = purchaseCount * video.price;

        const stats = {
            purchase_count: purchaseCount,
            access_count: accessCount,
            total_revenue: totalRevenue,
            unique_users: uniqueUsers
        };

        res.json({
            success: true,
            stats: stats
        });

    } catch (error) {
        console.error('❌ Ошибка получения статистики:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка сервера' 
        });
    }
});

// Функции для альтернативного доступа
async function getNewInviteLink(videoId) {
    try {
        showMessage('⏳ Создаем новую ссылку...', 'info');
        
        const response = await fetch(`/api/webapp/private-videos/${videoId}/new-invite?userId=${currentUserId}`);
        const result = await response.json();
        
        if (result.success && result.invite_link) {
            await handleInviteLink(result.invite_link, result.video_title);
        } else {
            throw new Error(result.error || 'Не удалось создать ссылку');
        }
    } catch (error) {
        console.error('Ошибка получения новой ссылки:', error);
        showMessage(`❌ ${error.message}`, 'error');
    }
}

async function checkAccessStatus(videoId) {
    try {
        const response = await fetch(`/api/webapp/private-videos/${videoId}/access-status?userId=${currentUserId}`);
        const result = await response.json();
        
        let message = '📊 Статус доступа:\n\n';
        
        if (result.has_access) {
            message += '✅ Доступ активен\n';
            message += `📅 Истекает: ${new Date(result.expires_at).toLocaleDateString()}\n`;
            message += `🔗 Канал: ${result.channel_name || 'Неизвестно'}\n`;
            
            if (result.in_channel) {
                message += '👤 Вы в канале\n';
            } else {
                message += '❌ Вы не в канале\n';
            }
        } else {
            message += '❌ Доступ отсутствует\n';
            if (result.reason) {
                message += `Причина: ${result.reason}\n`;
            }
        }
        
        alert(message);
        
    } catch (error) {
        console.error('Ошибка проверки статуса:', error);
        showMessage('❌ Ошибка проверки статуса доступа', 'error');
    }
}

function contactSupport(videoId) {
    const message = `Проблема с доступом к материалу ID: ${videoId}\nПользователь: ${currentUserId}\nВремя: ${new Date().toISOString()}`;
    
    // Открываем Telegram для связи с поддержкой
    const supportUsername = 'ваш_аккаунт_поддержки'; // Замените на реальный username
    const telegramUrl = `https://t.me/${supportUsername}?text=${encodeURIComponent(message)}`;
    
    window.open(telegramUrl, '_blank');
    showMessage('💬 Открываем чат с поддержкой...', 'info');
}

// Упрощенная функция отправки доступа
async function sendVideoAccessToUser(userId, video) {
    try {
        console.log(`📨 Отправляем доступ пользователю ${userId} на материал: ${video.title}`);
        
        if (!TELEGRAM_BOT_TOKEN) {
            console.log('⚠️ Токен бота не настроен, пропускаем отправку');
            return { success: false, error: 'Токен бота не настроен' };
        }

        // Создаем сообщение с инвайт-ссылкой
        const message = `🎬 *Вы получили доступ к приватному материалу!*

📹 *${video.title}*

${video.description ? `📝 ${video.description}\\n` : ''}
${video.duration ? `⏱️ Длительность: ${video.duration}\\n` : ''}
🎯 *Уровень:* ${getLevelName(video.level)}
📚 *Категория:* ${getCategoryName(video.category)}

🔗 *Инвайт-ссылка в канал:*
${video.invite_link}

💡 *Инструкция:*
1. Нажмите на инвайт-ссылку выше
2. Вступите в канал
3. Найдите материал в канале

⏰ *Доступ активен:* 30 дней
📅 *Истекает:* ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('ru-RU')}

Приятного просмотра! 🎉`;

        // Отправляем сообщение через Telegram Bot API
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: userId,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: false,
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: "🔗 Вступить в канал",
                            url: video.invite_link
                        }
                    ]]
                }
            })
        });

        const result = await response.json();
        
        if (result.ok) {
            console.log(`✅ Сообщение с доступом отправлено пользователю ${userId}`);
            return {
                success: true,
                message_id: result.result.message_id
            };
        } else {
            console.error(`❌ Ошибка отправки сообщения:`, result.description);
            return {
                success: false,
                error: result.description
            };
        }

    } catch (error) {
        console.error(`💥 Ошибка отправки доступа пользователю ${userId}:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Вспомогательные функции для форматирования (оставляем только нужные)
function getCategoryName(category) {
    const categories = {
        'video': '🎥 Видео',
        'course': '🎓 Курс', 
        'lesson': '📖 Урок',
        'masterclass': '⚡ Мастер-класс',
        'material': '📚 Материал'
    };
    return categories[category] || category;
}

function getLevelName(level) {
    const levels = {
        'beginner': '👶 Начинающий',
        'intermediate': '🚀 Продвинутый',
        'advanced': '🔥 Эксперт'
    };
    return levels[level] || level;
}

// Получить приватные видео пользователя
app.get('/api/webapp/user/private-videos', (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId) {
            return res.status(401).json({ 
                success: false,
                error: 'Требуется авторизация' 
            });
        }

        const userAccess = db.video_access.filter(access => 
            access.user_id == userId && access.expires_at > new Date().toISOString()
        );

        const accessibleVideos = userAccess.map(access => {
            const video = db.private_channel_videos.find(v => v.id === access.video_id && v.is_active);
            if (!video) return null;
            
            return {
                ...video,
                access_id: access.id,
                purchased_at: access.purchased_at,
                expires_at: access.expires_at,
                days_remaining: Math.ceil((new Date(access.expires_at) - new Date()) / (1000 * 60 * 60 * 24))
            };
        }).filter(video => video !== null);

        // Также возвращаем доступные для покупки видео
        const availableVideos = db.private_channel_videos.filter(video => 
            video.is_active && 
            !userAccess.some(access => access.video_id === video.id)
        );

        res.json({
            accessible_videos: accessibleVideos,
            available_videos: availableVideos
        });

    } catch (error) {
        console.error('❌ Ошибка получения приватных видео:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка сервера' 
        });
    }
});
// ==================== ИСПРАВЛЕННЫЕ API ДЛЯ ПРИВАТНЫХ МАТЕРИАЛОВ ====================

// server.js - Простой endpoint для информации о видео
app.get('/api/webapp/private-videos/:videoId', (req, res) => {
    try {
        const videoId = parseInt(req.params.videoId);
        const userId = parseInt(req.query.userId);
        
        const video = db.private_channel_videos.find(v => v.id === videoId && v.is_active);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        
        // Формируем прямую ссылку
        const directUrl = `https://t.me/c/${video.channel_id.toString().replace('-100', '')}/${video.message_id}`;
        
        // Проверяем доступ
        const hasAccess = db.video_access.some(access => 
            access.user_id === userId && 
            access.video_id === videoId &&
            access.expires_at > new Date().toISOString()
        );
        
        res.json({
            id: video.id,
            title: video.title,
            description: video.description,
            price: video.price,
            duration: video.duration,
            category: video.category,
            level: video.level,
            channel_id: video.channel_id,
            message_id: video.message_id,
            direct_url: directUrl,
            has_access: hasAccess
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения информации о видео:', error);
        res.status(500).json({ error: 'Server error' });
    }
});
// ФУНКЦИЯ ДЛЯ ОБНОВЛЕНИЯ СТАТИСТИКИ ВИДЕО
function updateVideoStats(videoId) {
    const video = db.private_channel_videos.find(v => v.id === videoId);
    if (!video) return null;
    
    const purchaseCount = db.purchases.filter(p => 
        p.item_id === videoId && p.item_type === 'private_video'
    ).length;
    
    const accessCount = db.video_access.filter(access => 
        access.video_id === videoId
    ).length;
    
    const totalRevenue = purchaseCount * video.price;
    
    return {
        purchase_count: purchaseCount,
        access_count: accessCount,
        total_revenue: totalRevenue
    };
}

// Функция предоставления доступа через Telegram бота
async function grantVideoAccess(userId, videoId) {
    try {
        const user = db.users.find(u => u.user_id == userId);
        const video = db.private_channel_videos.find(v => v.id == videoId);
        const accessRecord = db.video_access.find(a => a.user_id === userId && a.video_id === videoId);
        
        if (!user || !video || !accessRecord) {
            throw new Error('Данные для предоставления доступа не найдены');
        }
        
        // Создаем уникальную ссылку-приглашение в канал
        const chatInviteLink = await bot.createChatInviteLink(PRIVATE_CHANNEL_CONFIG.CHANNEL_ID, {
            member_limit: 1,
            expire_date: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 часа
        });
        
        // Отправляем пользователю сообщение с доступом
        const message = await bot.sendMessage(userId, 
            `🎬 Вам предоставлен доступ к видео!\n\n` +
            `📹 ${video.title}\n` +
            `⏱️ Длительность: ${video.duration}\n` +
            `💾 Размер: ${video.file_size}\n\n` +
            `🔗 Ссылка для просмотра: ${chatInviteLink.invite_link}\n\n` +
            `⚠️ Ссылка действительна 24 часа. Для повторного доступа напишите "доступ" в этот чат.`,
            { parse_mode: 'HTML' }
        );
        
        // Сохраняем ID сообщения
        accessRecord.telegram_message_id = message.message_id;
        
        console.log(`✅ Доступ к видео ${videoId} предоставлен пользователю ${userId}`);
        
    } catch (error) {
        console.error('❌ Ошибка предоставления доступа:', error);
        throw error;
    }
}

// Получить приватные материалы для админки
app.get('/api/admin/private-videos', requireAdmin, (req, res) => {
    try {
        const videos = db.private_channel_videos.map(video => {
            const purchaseCount = db.purchases.filter(p => 
                p.item_id === video.id && p.item_type === 'private_video'
            ).length;
            
            const totalRevenue = purchaseCount * video.price;
            
            return {
                id: video.id,
                invite_link: video.invite_link,
                title: video.title,
                description: video.description,
                duration: video.duration,
                price: video.price,
                category: video.category,
                level: video.level,
                is_active: video.is_active,
                created_at: video.created_at,
                purchase_count: purchaseCount,
                total_revenue: totalRevenue
            };
        });
        
        res.json(videos);
    } catch (error) {
        console.error('❌ Ошибка получения приватных видео:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});


app.delete('/api/admin/private-videos/:videoId', requireAdmin, (req, res) => {
    const videoId = parseInt(req.params.videoId);
    const videoIndex = db.private_channel_videos.findIndex(v => v.id === videoId);
    
    if (videoIndex === -1) {
        return res.status(404).json({ error: 'Video not found' });
    }
    
    // Проверяем, есть ли пользователи с доступом
    const usersWithAccess = db.video_access.filter(access => access.video_id === videoId);
    if (usersWithAccess.length > 0) {
        return res.status(400).json({ 
            error: 'Нельзя удалить видео, у которого есть пользователи с доступом' 
        });
    }
    
    db.private_channel_videos.splice(videoIndex, 1);
    res.json({ success: true, message: 'Видео удалено' });
});

// Простой эндпоинт для проверки работы
app.get('/api/test', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Сервер работает',
        timestamp: new Date().toISOString()
    });
});

// Упрощенное создание приватного материала
app.post('/api/admin/private-videos', requireAdmin, async (req, res) => {
    try {
        console.log('🎬 Создание приватного материала - полученные данные:', req.body);
        
        const { 
            invite_link,
            title, 
            description, 
            duration, 
            price, 
            category, 
            level, 
            is_active 
        } = req.body;

        console.log('🔍 Проверка обязательных полей:', {
            hasInviteLink: !!invite_link,
            hasTitle: !!title,
            hasPrice: !!price
        });

        // Валидация обязательных полей
        if (!invite_link) {
            return res.status(400).json({ 
                success: false, 
                error: 'Инвайт-ссылка обязательна' 
            });
        }

        if (!title) {
            return res.status(400).json({ 
                success: false, 
                error: 'Название обязательно' 
            });
        }

        if (!price || isNaN(price)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Цена должна быть числом' 
            });
        }

        // Проверка на дубликаты
        const existingVideo = db.private_channel_videos.find(v => 
            v.invite_link === invite_link
        );
        
        if (existingVideo) {
            return res.status(400).json({ 
                success: false, 
                error: 'Материал с такой инвайт-ссылкой уже существует' 
            });
        }

        // Создание нового материала
        const newVideo = {
            id: Date.now(),
            invite_link: invite_link,
            title: title,
            description: description || `Приватный материал. Инвайт-ссылка: ${invite_link}`,
            duration: duration || 'Не указано',
            price: parseFloat(price),
            category: category || 'video',
            level: level || 'beginner',
            is_active: is_active !== undefined ? is_active : true,
            created_at: new Date().toISOString()
        };

        db.private_channel_videos.push(newVideo);

        console.log('✅ Приватный материал создан:', newVideo.title);

        res.json({
            success: true,
            video: newVideo,
            message: 'Приватный материал успешно создан!'
        });

    } catch (error) {
        console.error('❌ Ошибка создания приватного видео:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка сервера при создании материала: ' + error.message 
        });
    }
});

// server.js - ENDPOINT ДЛЯ ПРЕДВАРИТЕЛЬНОГО ПАРСИНГА ССЫЛКИ
app.post('/api/admin/parse-telegram-url', requireAdmin, async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ 
                success: false, 
                error: 'URL обязателен' 
            });
        }

        console.log('🔗 Парсинг URL:', url);
        const telegramData = parseTelegramUrl(url);
        
        if (!telegramData.success) {
            return res.json({
                success: false,
                error: telegramData.error
            });
        }

        // ДОПОЛНИТЕЛЬНАЯ ИНФОРМАЦИЯ ДЛЯ ПУБЛИЧНЫХ КАНАЛОВ
        let channelInfo = null;
        if (telegramData.channelUsername && !telegramData.isPrivateChannel) {
            channelInfo = await getChannelIdByUsername(telegramData.channelUsername);
        }

        res.json({
            success: true,
            parsed_data: telegramData,
            channel_info: channelInfo,
            suggested_title: `Материал из ${telegramData.isPrivateChannel ? 'приватного канала' : 'канала'} ${telegramData.channelUsername || 'Telegram'}`,
            suggested_description: `Приватный материал из Telegram. Ссылка: ${url}`,
            direct_url: telegramData.directUrl
        });

    } catch (error) {
        console.error('❌ Ошибка парсинга URL:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка парсинга ссылки' 
        });
    }
});

// НОВЫЙ МЕТОД ДЛЯ СМЕНЫ РОЛИ
app.post('/api/users/change-role', (req, res) => {
    const { userId, roleId, characterId } = req.body;
    
    if (!userId || !roleId) {
        return res.status(400).json({ error: 'User ID and role are required' });
    }
    
    const user = db.users.find(u => u.user_id == userId);
    const role = db.roles.find(r => r.id == roleId);
    const character = db.characters.find(c => c.id == characterId);
    
    if (!user || !role) {
        return res.status(404).json({ error: 'User or role not found' });
    }
    
    if (!user.is_registered) {
        return res.status(400).json({ error: 'User not registered' });
    }
    
    // Сохраняем старую роль для лога
    const oldRole = user.class;
    
    user.class = role.name;
    user.character_id = characterId;
    user.character_name = character ? character.name : null;
    user.available_buttons = role.available_buttons;
    user.last_active = new Date().toISOString();
    
    // Логируем смену роли (0 искр)
    addSparks(userId, SPARKS_SYSTEM.ROLE_CHANGE, 'role_change', `Смена роли: ${oldRole} → ${role.name}`);
    
    res.json({ 
        success: true, 
        message: 'Роль успешно изменена!',
        user: user
    });
});

// ✅ ПРАВИЛЬНАЯ РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ
app.post('/api/users/register', (req, res) => {
    try {
        const { userId, firstName, username, roleId, characterId } = req.body;
        
        console.log('📝 Регистрация пользователя:', { userId, firstName, username, roleId, characterId });
        
        if (!userId || !firstName || !roleId) {
            return res.status(400).json({ 
                success: false,
                error: 'User ID, first name and role are required' 
            });
        }
        
        // Проверяем существующего пользователя
        let user = db.users.find(u => u.user_id == userId);
        const role = db.roles.find(r => r.id == roleId);
        const character = db.characters.find(c => c.id == characterId);
        
        if (!role) {
            return res.status(404).json({ 
                success: false,
                error: 'Role not found' 
            });
        }
        
        const isNewUser = !user;
        
        if (!user) {
            // СОЗДАЕМ НОВОГО РЕАЛЬНОГО ПОЛЬЗОВАТЕЛЯ
            user = {
                id: Date.now(),
                user_id: parseInt(userId),
                tg_first_name: firstName,
                tg_username: username || `user_${userId}`,
                sparks: 10, // Стартовый бонус
                level: 'Ученик',
                is_registered: true,
                class: role.name,
                character_id: characterId || 1,
                character_name: character ? character.name : 'Лука Цветной',
                available_buttons: role.available_buttons || ['quiz', 'marathon', 'works', 'activities', 'posts', 'shop', 'invite', 'interactives', 'change_role'],
                registration_date: new Date().toISOString(),
                last_active: new Date().toISOString()
            };
            db.users.push(user);
            
            // НАЧИСЛЯЕМ СТАРТОВЫЕ ИСКРЫ
            addSparks(userId, 10, 'registration_bonus', 'Стартовый бонус за регистрацию');
            
            console.log(`✅ Новый реальный пользователь создан: ${firstName} (ID: ${userId})`);
        } else {
            // ОБНОВЛЯЕМ СУЩЕСТВУЮЩЕГО ПОЛЬЗОВАТЕЛЯ
            user.tg_first_name = firstName;
            user.tg_username = username || user.tg_username;
            user.class = role.name;
            user.character_id = characterId || user.character_id;
            user.character_name = character ? character.name : user.character_name;
            user.is_registered = true;
            user.available_buttons = role.available_buttons;
            user.last_active = new Date().toISOString();
        }
        
        // АВТОМАТИЧЕСКИ ДОБАВЛЯЕМ АДМИНА ЕСЛИ ЭТО АДМИН
        if ([898508164, 79156202620, 781959267].includes(parseInt(userId))) {
            const adminExists = db.admins.find(a => a.user_id == userId);
            if (!adminExists) {
                db.admins.push({
                    id: Date.now(),
                    user_id: parseInt(userId),
                    username: username || `admin_${userId}`,
                    role: 'admin',
                    created_at: new Date().toISOString()
                });
                console.log(`✅ Пользователь ${userId} добавлен как админ`);
            }
        }
        
        console.log('✅ Успешная регистрация:', {
            id: user.user_id,
            name: user.tg_first_name,
            role: user.class,
            sparks: user.sparks
        });
        
        res.json({ 
            success: true, 
            message: isNewUser ? 
                `Регистрация успешна! +10✨ стартового бонуса` : 
                'Профиль обновлен!',
            user: user
        });
        
    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка регистрации' 
        });
    }
});

// ✅ ПРАВИЛЬНОЕ ПОЛУЧЕНИЕ ПОЛЬЗОВАТЕЛЯ
app.get('/api/users/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        console.log('👤 Запрос реального пользователя:', userId);
        
        const user = db.users.find(u => u.user_id === userId);
        
        if (!user) {
            console.log('❌ Пользователь не найден, возвращаем exists: false');
            return res.json({ 
                exists: false,
                user: null
            });
        }
        
        console.log('✅ Пользователь найден:', user.tg_first_name);
        res.json({ 
            exists: true, 
            user: user
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения пользователя:', error);
        res.status(500).json({ 
            exists: false,
            error: 'Ошибка сервера' 
        });
    }
});
app.get('/api/webapp/roles', (req, res) => {
    try {
        console.log('📋 Запрос на получение ролей');
        const roles = db.roles.filter(role => role.is_active);
        console.log('✅ Найдено ролей:', roles.length);
        console.log('📝 Роли:', roles.map(r => r.name));
        res.json(roles);
    } catch (error) {
        console.error('❌ Ошибка получения ролей:', error);
        res.status(500).json({ error: 'Ошибка загрузки ролей' });
    }
});

app.get('/api/webapp/characters/:roleId', (req, res) => {
    try {
        const roleId = parseInt(req.params.roleId);
        console.log('👥 Запрос персонажей для роли:', roleId);
        
        const characters = db.characters.filter(char => 
            char.role_id === roleId && char.is_active
        );
        
        console.log('✅ Найдено персонажей:', characters.length);
        res.json(characters);
    } catch (error) {
        console.error('❌ Ошибка получения персонажей:', error);
        res.status(500).json({ error: 'Ошибка загрузки персонажей' });
    }
});

app.get('/api/webapp/quizzes', (req, res) => {
    const userId = parseInt(req.query.userId);
    const quizzes = db.quizzes.filter(q => q.is_active);
    
    const quizzesWithStatus = quizzes.map(quiz => {
        const completion = db.quiz_completions.find(
            qc => qc.user_id === userId && qc.quiz_id === quiz.id
        );
        
        let canRetake = quiz.allow_retake;
        if (completion && quiz.cooldown_hours > 0) {
            const lastCompletion = new Date(completion.completed_at);
            const now = new Date();
            const hoursSinceCompletion = (now - lastCompletion) / (1000 * 60 * 60);
            canRetake = hoursSinceCompletion >= quiz.cooldown_hours;
        }
        
        return {
            ...quiz,
            completed: !!completion,
            user_score: completion ? completion.score : 0,
            total_questions: quiz.questions.length,
            can_retake: canRetake && quiz.allow_retake,
            last_completion: completion ? completion.completed_at : null
        };
    });
    
    res.json(quizzesWithStatus);
});

// ✅ ИСПРАВЛЕННЫЙ ENDPOINT ДЛЯ ОТПРАВКИ КВИЗА
app.post('/api/webapp/quizzes/:quizId/submit', (req, res) => {
    try {
        const quizId = parseInt(req.params.quizId);
        const { userId, answers } = req.body;
        
        console.log('📝 Отправка результатов квиза:', { quizId, userId, answers });
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }
        
        const quiz = db.quizzes.find(q => q.id === quizId);
        if (!quiz) {
            return res.status(404).json({ error: 'Quiz not found' });
        }
        
        const existingCompletion = db.quiz_completions.find(
            qc => qc.user_id === userId && qc.quiz_id === quizId
        );
        
        if (existingCompletion && !quiz.allow_retake) {
            return res.status(400).json({ error: 'Этот квиз нельзя пройти повторно' });
        }
        
        if (existingCompletion && quiz.cooldown_hours > 0) {
            const lastCompletion = new Date(existingCompletion.completed_at);
            const now = new Date();
            const hoursSinceCompletion = (now - lastCompletion) / (1000 * 60 * 60);
            
            if (hoursSinceCompletion < quiz.cooldown_hours) {
                const hoursLeft = Math.ceil(quiz.cooldown_hours - hoursSinceCompletion);
                return res.status(400).json({ 
                    error: `Квиз можно пройти повторно через ${hoursLeft} часов` 
                });
            }
        }
        
        let correctAnswers = 0;
        quiz.questions.forEach((question, index) => {
            if (answers[index] === question.correctAnswer) {
                correctAnswers++;
            }
        });
        
        // НАЧИСЛЕНИЕ ИСКР
        let sparksEarned = 0;
        const perfectScore = correctAnswers === quiz.questions.length;
        
        // Начисляем искры за правильные ответы
        sparksEarned = correctAnswers * quiz.sparks_per_correct;
        
        // Добавляем бонус за идеальный результат
        if (perfectScore) {
            sparksEarned += quiz.sparks_perfect_bonus;
        }
        
        if (existingCompletion) {
            existingCompletion.score = correctAnswers;
            existingCompletion.sparks_earned = sparksEarned;
            existingCompletion.perfect_score = perfectScore;
            existingCompletion.completed_at = new Date().toISOString();
        } else {
            db.quiz_completions.push({
                id: Date.now(),
                user_id: userId,
                quiz_id: quizId,
                completed_at: new Date().toISOString(),
                score: correctAnswers,
                sparks_earned: sparksEarned,
                perfect_score: perfectScore
            });
        }
        
        if (sparksEarned > 0) {
            addSparks(userId, sparksEarned, 'quiz', `Квиз: ${quiz.title}`);
        }
        
        res.json({
            success: true,
            correctAnswers,
            totalQuestions: quiz.questions.length,
            sparksEarned,
            perfectScore,
            scorePercentage: Math.round((correctAnswers / quiz.questions.length) * 100),
            message: perfectScore ? 
                `Идеально! 🎉 +${sparksEarned}✨ (${correctAnswers}×${quiz.sparks_per_correct} + ${quiz.sparks_perfect_bonus} бонус)` : 
                `Правильно: ${correctAnswers}/${quiz.questions.length}. +${sparksEarned}✨ (${correctAnswers}×${quiz.sparks_per_correct})`
        });
        
    } catch (error) {
        console.error('❌ Ошибка отправки результатов квиза:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка сервера при обработке результатов' 
        });
    }
});
app.get('/api/webapp/marathons', (req, res) => {
    const userId = parseInt(req.query.userId);
    const marathons = db.marathons.filter(m => m.is_active);
    
    const marathonsWithStatus = marathons.map(marathon => {
        const completion = db.marathon_completions.find(
            mc => mc.user_id === userId && mc.marathon_id === marathon.id
        );
        
        const currentTask = completion ? marathon.tasks[completion.current_day - 1] : marathon.tasks[0];
        
        return {
            ...marathon,
            completed: completion ? completion.completed : false,
            current_day: completion ? completion.current_day : 1,
            progress: completion ? completion.progress : 0,
            started_at: completion ? completion.started_at : null,
            current_task: currentTask
        };
    });
    
    res.json(marathonsWithStatus);
});

// НОВЫЙ МЕТОД ДЛЯ ОТПРАВКИ РАБОТЫ В МАРАФОНЕ
app.post('/api/webapp/marathons/:marathonId/submit-day', (req, res) => {
    console.log('📤 Отправка работы марафона, размер данных:', (req.headers['content-length'] / 1024 / 1024).toFixed(2), 'MB');
    
    const marathonId = parseInt(req.params.marathonId);
    const { userId, day, submission_text, submission_image } = req.body;
    
    if (!userId || !day) {
        return res.status(400).json({ error: 'User ID and day are required' });
    }
    
    const marathon = db.marathons.find(m => m.id === marathonId);
    if (!marathon) {
        return res.status(404).json({ error: 'Marathon not found' });
    }
    
    const task = marathon.tasks.find(t => t.day === day);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    
    // Проверяем требования к заданию
    if (task.requires_submission && !submission_text && !submission_image) {
        return res.status(400).json({ error: 'Это задание требует отправки работы' });
    }
    
    let completion = db.marathon_completions.find(
        mc => mc.user_id === userId && mc.marathon_id === marathonId
    );
    
    if (!completion) {
        completion = {
            id: Date.now(),
            user_id: userId,
            marathon_id: marathonId,
            current_day: 1,
            progress: 0,
            completed: false,
            started_at: new Date().toISOString()
        };
        db.marathon_completions.push(completion);
    }
    
    if (completion.current_day !== day) {
        return res.status(400).json({ error: 'Неверный день марафона' });
    }
    
    // Сохраняем работу пользователя
    if (submission_text || submission_image) {
        db.marathon_submissions.push({
            id: Date.now(),
            user_id: userId,
            marathon_id: marathonId,
            day: day,
            submission_text: submission_text,
            submission_image: submission_image,
            submitted_at: new Date().toISOString(),
            status: 'pending'
        });
    }
    
    // Начисляем искры только после отправки работы
    const sparksEarned = marathon.sparks_per_day;
    addSparks(userId, sparksEarned, 'marathon_day', `Марафон: ${marathon.title} - день ${day}`);
    
    completion.current_day = day + 1;
    completion.progress = Math.round((day / marathon.duration_days) * 100);
    
    if (day >= marathon.duration_days) {
        completion.completed = true;
        completion.progress = 100;
        
        // Дополнительная награда за завершение марафона
        const marathonBonus = marathon.sparks_per_day * 2;
        addSparks(userId, marathonBonus, 'marathon_completion', `Завершение марафона: ${marathon.title}`);
    }
    
    res.json({
        success: true,
        sparksEarned,
        currentDay: completion.current_day,
        progress: completion.progress,
        completed: completion.completed,
        message: completion.completed ? 
            `🎉 Марафон завершен! +${sparksEarned}✨ (день) + ${marathon.sparks_per_day * 2}✨ (бонус)` : 
            `День ${day} завершен! +${sparksEarned}✨`
    });
});

// Получение товаров магазина
app.get('/api/webapp/shop/items', (req, res) => {
    try {
        console.log('🛒 Запрос товаров магазина');
        const items = db.shop_items.filter(item => item.is_active);
        
        // Форматируем ответ для клиента
        const formattedItems = items.map(item => ({
            id: item.id,
            title: item.title,
            description: item.description,
            type: item.type,
            price: item.price,
            preview_url: item.preview_url,
            content_text: item.content_text,
            embed_html: item.embed_html,
            is_active: item.is_active,
            created_at: item.created_at
        }));
        
        console.log(`✅ Отправлено товаров: ${formattedItems.length}`);
        res.json(formattedItems);
        
    } catch (error) {
        console.error('❌ Ошибка загрузки товаров:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка загрузки товаров' 
        });
    }
});

// Получение покупок пользователя
app.get('/api/webapp/users/:userId/purchases', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        console.log('📦 Запрос покупок пользователя:', userId);
        
        const userPurchases = db.purchases
            .filter(p => p.user_id === userId && p.item_type === 'shop_item')
            .map(purchase => {
                const item = db.shop_items.find(i => i.id === purchase.item_id);
                return { 
                    ...purchase, 
                    title: item?.title,
                    description: item?.description,
                    type: item?.type,
                    file_url: item?.file_url,
                    content_text: item?.content_text,
                    preview_url: item?.preview_url,
                    embed_html: item?.embed_html
                };
            })
            .sort((a, b) => new Date(b.purchased_at) - new Date(a.purchased_at));
            
        console.log(`✅ Найдено покупок: ${userPurchases.length}`);
        res.json({ 
            success: true,
            purchases: userPurchases 
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения покупок:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка загрузки покупок',
            purchases: []
        });
    }
});

// ==================== БАЗОВЫЕ МАРШРУТЫ ДЛЯ ПРОВЕРКИ ====================

// Проверка всех API маршрутов
app.get('/api/debug/routes', (req, res) => {
    const routes = [
        '/api/health',
        '/api/test', 
        '/api/users/:userId',
        '/api/webapp/shop/items',
        '/api/webapp/shop/purchase',
        '/api/webapp/users/:userId/purchases',
        '/api/webapp/quizzes',
        '/api/webapp/marathons',
        '/api/webapp/interactives',
        '/api/webapp/roles',
        '/api/webapp/characters/:roleId'
    ];
    
    res.json({
        success: true,
        routes: routes,
        message: 'Доступные API маршруты'
    });
});

// Простой тестовый эндпоинт
app.get('/api/test-shop', (req, res) => {
    res.json({
        success: true,
        message: 'Магазин работает!',
        shop_items_count: db.shop_items.filter(i => i.is_active).length,
        timestamp: new Date().toISOString()
    });
});

// ✅ УЛУЧШЕННАЯ ФУНКЦИЯ ПОКУПКИ НА КЛИЕНТЕ
async function purchaseItem(itemId) {
    try {
        showMessage('🛒 Обрабатываем покупку...', 'info');
        
        const response = await fetch('/api/webapp/shop/purchase', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userId: currentUserId,
                itemId: itemId
            })
        });

        // Проверяем, что ответ JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('❌ Сервер вернул не JSON:', text.substring(0, 200));
            throw new Error('Ошибка сервера: неверный формат ответа');
        }

        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || `HTTP error! status: ${response.status}`);
        }
        
        if (result.success) {
            showMessage(result.message, 'success');
            // Обновляем баланс
            await loadUserData();
            // Перезагружаем магазин
            loadShopItems();
        } else {
            throw new Error(result.error || 'Неизвестная ошибка');
        }
        
    } catch (error) {
        console.error('❌ Ошибка покупки:', error);
        showMessage(`❌ ${error.message}`, 'error');
    }
}

app.get('/api/webapp/users/:userId/activities', (req, res) => {
    const userId = parseInt(req.params.userId);
    const userActivities = db.activities
        .filter(a => a.user_id === userId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 50);
    res.json({ activities: userActivities });
});

// Работы пользователя
app.post('/api/webapp/upload-work', (req, res) => {
    console.log('📤 Загрузка работы, размер данных:', (req.headers['content-length'] / 1024 / 1024).toFixed(2), 'MB');
    
    const { userId, title, description, imageUrl, type } = req.body;
    
    if (!userId || !title || !imageUrl) {
        return res.status(400).json({ error: 'User ID, title and image URL are required' });
    }
    
    const user = db.users.find(u => u.user_id == userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const newWork = {
        id: Date.now(),
        user_id: userId,
        title,
        description: description || '',
        image_url: imageUrl,
        type: type || 'image',
        status: 'pending',
        created_at: new Date().toISOString(),
        moderated_at: null,
        moderator_id: null,
        admin_comment: null
    };
    
    db.user_works.push(newWork);
    
    addSparks(userId, SPARKS_SYSTEM.UPLOAD_WORK, 'upload_work', `Загрузка работы: ${title}`);
    
    res.json({
        success: true,
        message: `Работа успешно загружена! Получено +${SPARKS_SYSTEM.UPLOAD_WORK}✨. После одобрения вы получите +${SPARKS_SYSTEM.WORK_APPROVED}✨`,
        workId: newWork.id,
        work: newWork
    });
});

app.get('/api/webapp/users/:userId/works', (req, res) => {
    const userId = parseInt(req.params.userId);
    const userWorks = db.user_works
        .filter(w => w.user_id === userId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ works: userWorks });
});

// Посты канала
app.get('/api/webapp/channel-posts', (req, res) => {
    const posts = db.channel_posts
        .filter(p => p.is_active)
        .map(post => {
            const reviews = db.post_reviews.filter(r => r.post_id === post.post_id);
            return {
                ...post,
                reviews_count: reviews.length,
                average_rating: reviews.length > 0 ? 
                    reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : 0
            };
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
    res.json({ posts: posts });
});

app.post('/api/webapp/posts/:postId/review', (req, res) => {
    const postId = req.params.postId;
    const { userId, reviewText, rating } = req.body;
    
    if (!userId || !reviewText) {
        return res.status(400).json({ error: 'User ID and review text are required' });
    }
    
    const post = db.channel_posts.find(p => p.post_id === postId);
    if (!post) {
        return res.status(404).json({ error: 'Post not found' });
    }
    
    const existingReview = db.post_reviews.find(
        r => r.user_id === userId && r.post_id === postId
    );
    
    if (existingReview) {
        return res.status(400).json({ error: 'Вы уже оставляли отзыв на этот пост' });
    }
    
    const today = new Date().toDateString();
    const todayReviews = db.daily_reviews.filter(
        dr => dr.user_id === userId && new Date(dr.date).toDateString() === today
    );
    
    let sparksEarned = SPARKS_SYSTEM.WRITE_REVIEW;
    
    if (todayReviews.length === 0) {
        sparksEarned += SPARKS_SYSTEM.DAILY_COMMENT;
        
        db.daily_reviews.push({
            id: Date.now(),
            user_id: userId,
            date: new Date().toISOString(),
            type: 'daily_comment'
        });
    }
    
    const newReview = {
        id: Date.now(),
        user_id: userId,
        post_id: postId,
        review_text: reviewText,
        rating: rating || 5,
        status: 'pending',
        created_at: new Date().toISOString(),
        moderated_at: null,
        moderator_id: null,
        admin_comment: null
    };
    
    db.post_reviews.push(newReview);
    
    addSparks(userId, sparksEarned, 'post_review', `Отзыв к посту: ${post.title}`);
    
    const message = todayReviews.length === 0 
        ? `Отзыв отправлен! +${sparksEarned}✨ (3 за отзыв + 1 за первый комментарий сегодня)`
        : `Отзыв отправлен! +${sparksEarned}✨`;
    
    res.json({
        success: true,
        message: message,
        reviewId: newReview.id,
        sparksEarned: sparksEarned
    });
});

// GET /api/webapp/roles/:roleId
app.get('/api/webapp/roles/:roleId', async (req, res) => {
    try {
        const { roleId } = req.params;
        const role = await db.get('SELECT * FROM roles WHERE id = ?', [roleId]);
        
        if (!role) {
            return res.status(404).json({ error: 'Роль не найдена' });
        }
        
        // Парсим available_buttons из JSON строки
        if (role.available_buttons) {
            try {
                role.available_buttons = JSON.parse(role.available_buttons);
            } catch (e) {
                role.available_buttons = [];
            }
        } else {
            role.available_buttons = [];
        }
        
        res.json(role);
    } catch (error) {
        console.error('Ошибка получения роли:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// GET /api/webapp/characters/:characterId
app.get('/api/webapp/characters/:characterId', async (req, res) => {
    try {
        const { characterId } = req.params;
        const character = await db.get('SELECT * FROM characters WHERE id = ?', [characterId]);
        
        if (!character) {
            return res.status(404).json({ error: 'Персонаж не найден' });
        }
        
        // Парсим available_buttons из JSON строки
        if (character.available_buttons) {
            try {
                character.available_buttons = JSON.parse(character.available_buttons);
            } catch (e) {
                character.available_buttons = [];
            }
        } else {
            character.available_buttons = [];
        }
        
        res.json(character);
    } catch (error) {
        console.error('Ошибка получения персонажа:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ==================== ДОПОЛНИТЕЛЬНЫЕ API ДЛЯ АДМИНКИ ====================

// ✅ ИСПРАВИТЬ СУЩЕСТВУЮЩИЙ ENDPOINT - добавить правильную логику
app.get('/api/admin/user-works', requireAdmin, (req, res) => {
    try {
        const { status = 'pending' } = req.query;
        
        console.log(`🖼️ Админ запросил работы со статусом: ${status}`);
        
        // ПРАВИЛЬНО ФИЛЬТРУЕМ РАБОТЫ ПО СТАТУСУ
        const works = db.user_works
            .filter(w => w.status === status)
            .map(work => {
                const user = db.users.find(u => u.user_id === work.user_id);
                return {
                    ...work,
                    user_name: user?.tg_first_name || 'Неизвестно',
                    user_username: user?.tg_username || 'нет username',
                    user_id: work.user_id // Добавляем ID пользователя
                };
            })
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // Сначала новые
        
        console.log(`✅ Найдено работ со статусом ${status}: ${works.length}`);
        
        // ЛОГ ДЛЯ ОТЛАДКИ
        if (works.length === 0) {
            console.log('📋 Все работы в базе:', db.user_works.map(w => ({
                id: w.id,
                title: w.title,
                status: w.status,
                user_id: w.user_id
            })));
        }
        
        res.json({ 
            success: true,
            works: works 
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения работ:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка сервера',
            works: []
        });
    }
});

// Модерация работы
app.post('/api/admin/user-works/:workId/moderate', requireAdmin, (req, res) => {
    try {
        const workId = parseInt(req.params.workId);
        const { status, admin_comment } = req.body;
        const adminId = req.admin.user_id;
        
        const work = db.user_works.find(w => w.id === workId);
        if (!work) {
            return res.status(404).json({ error: 'Work not found' });
        }
        
        work.status = status;
        work.moderated_at = new Date().toISOString();
        work.moderator_id = adminId;
        work.admin_comment = admin_comment || null;
        
        if (status === 'approved') {
            addSparks(work.user_id, SPARKS_SYSTEM.WORK_APPROVED, 'work_approved', `Работа одобрена: ${work.title}`);
        }
        
        res.json({ 
            success: true, 
            message: `Работа ${status === 'approved' ? 'одобрена' : 'отклонена'}`,
            work: work
        });
    } catch (error) {
        console.error('❌ Ошибка модерации работы:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ✅ ДОБАВИТЬ НОВЫЙ ENDPOINT ДЛЯ ПРОВЕРКИ РАБОТ
app.get('/api/admin/debug/user-works', requireAdmin, (req, res) => {
    try {
        const allWorks = db.user_works.map(work => {
            const user = db.users.find(u => u.user_id === work.user_id);
            return {
                id: work.id,
                title: work.title,
                status: work.status,
                user_id: work.user_id,
                user_name: user?.tg_first_name || 'Неизвестно',
                created_at: work.created_at,
                image_url: work.image_url ? 'Есть' : 'Нет'
            };
        });
        
        const stats = {
            total: db.user_works.length,
            pending: db.user_works.filter(w => w.status === 'pending').length,
            approved: db.user_works.filter(w => w.status === 'approved').length,
            rejected: db.user_works.filter(w => w.status === 'rejected').length
        };
        
        res.json({
            success: true,
            stats: stats,
            works: allWorks
        });
        
    } catch (error) {
        console.error('❌ Ошибка отладки работ:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка отладки' 
        });
    }
});

// Получить отзывы для модерации
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
    try {
        const { status = 'pending' } = req.query;
        
        const reviews = db.post_reviews
            .filter(r => r.status === status)
            .map(review => {
                const user = db.users.find(u => u.user_id === review.user_id);
                const post = db.channel_posts.find(p => p.post_id === review.post_id);
                const moderator = db.admins.find(a => a.user_id === review.moderator_id);
                return {
                    ...review,
                    tg_first_name: user?.tg_first_name,
                    tg_username: user?.tg_username,
                    post_title: post?.title,
                    moderator_username: moderator?.username
                };
            })
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        
        res.json({ reviews });
    } catch (error) {
        console.error('❌ Ошибка получения отзывов:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Модерация отзыва
app.post('/api/admin/reviews/:reviewId/moderate', requireAdmin, (req, res) => {
    try {
        const reviewId = parseInt(req.params.reviewId);
        const { status, admin_comment } = req.body;
        
        const review = db.post_reviews.find(r => r.id === reviewId);
        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }
        
        review.status = status;
        review.moderated_at = new Date().toISOString();
        review.moderator_id = req.admin.user_id;
        review.admin_comment = admin_comment || null;
        
        res.json({ 
            success: true, 
            message: `Отзыв ${status === 'approved' ? 'одобрен' : 'отклонен'}`,
            review: review
        });
    } catch (error) {
        console.error('❌ Ошибка модерации отзыва:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получить работы марафонов
app.get('/api/admin/marathon-submissions', requireAdmin, (req, res) => {
    try {
        const { marathon_id, day, status = 'pending' } = req.query;
        
        let submissions = db.marathon_submissions;
        
        if (marathon_id) {
            submissions = submissions.filter(s => s.marathon_id === parseInt(marathon_id));
        }
        
        if (day) {
            submissions = submissions.filter(s => s.day === parseInt(day));
        }
        
        if (status) {
            submissions = submissions.filter(s => s.status === status);
        }
        
        const submissionsWithDetails = submissions.map(submission => {
            const user = db.users.find(u => u.user_id === submission.user_id);
            const marathon = db.marathons.find(m => m.id === submission.marathon_id);
            const task = marathon?.tasks.find(t => t.day === submission.day);
            
            return {
                ...submission,
                user_name: user?.tg_first_name || 'Неизвестно',
                marathon_title: marathon?.title || 'Неизвестно',
                task_title: task?.title || 'Неизвестно'
            };
        }).sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
        
        res.json({ submissions: submissionsWithDetails });
    } catch (error) {
        console.error('❌ Ошибка получения работ марафонов:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Модерация работы марафона
app.post('/api/admin/marathon-submissions/:submissionId/moderate', requireAdmin, (req, res) => {
    try {
        const submissionId = parseInt(req.params.submissionId);
        const { status, admin_comment } = req.body;
        
        const submission = db.marathon_submissions.find(s => s.id === submissionId);
        if (!submission) {
            return res.status(404).json({ error: 'Submission not found' });
        }
        
        submission.status = status;
        submission.moderated_at = new Date().toISOString();
        submission.moderator_id = req.admin.user_id;
        submission.admin_comment = admin_comment || null;
        
        if (status === 'approved') {
            addSparks(submission.user_id, SPARKS_SYSTEM.MARATHON_SUBMISSION, 'marathon_submission_approved', `Работа марафона одобрена`);
        }
        
        res.json({ 
            success: true, 
            message: `Работа марафона ${status === 'approved' ? 'одобрена' : 'отклонена'}`,
            submission: submission
        });
    } catch (error) {
        console.error('❌ Ошибка модерации работы марафона:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// API ДЛЯ ИНТЕРАКТИВОВ
app.get('/api/webapp/interactives', (req, res) => {
    const userId = parseInt(req.query.userId);
    const interactives = db.interactives.filter(i => i.is_active);
    
    const interactivesWithStatus = interactives.map(interactive => {
        const completion = db.interactive_completions.find(
            ic => ic.user_id === userId && ic.interactive_id === interactive.id
        );
        
        return {
            ...interactive,
            completed: !!completion,
            user_score: completion ? completion.score : 0,
            can_retake: interactive.allow_retake && !completion
        };
    });
    
    res.json(interactivesWithStatus);
});

app.post('/api/webapp/interactives/:interactiveId/submit', (req, res) => {
    const interactiveId = parseInt(req.params.interactiveId);
    const { userId, answer } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }
    
    const interactive = db.interactives.find(i => i.id === interactiveId);
    if (!interactive) {
        return res.status(404).json({ error: 'Interactive not found' });
    }
    
    const existingCompletion = db.interactive_completions.find(
        ic => ic.user_id === userId && ic.interactive_id === interactiveId
    );
    
    if (existingCompletion && !interactive.allow_retake) {
        return res.status(400).json({ error: 'Вы уже прошли этот интерактив' });
    }
    
    const isCorrect = answer === interactive.correct_answer;
    const sparksEarned = isCorrect ? interactive.sparks_reward : 0;
    
    if (existingCompletion) {
        existingCompletion.score = isCorrect ? 1 : 0;
        existingCompletion.sparks_earned = sparksEarned;
        existingCompletion.completed_at = new Date().toISOString();
        existingCompletion.answer = answer;
    } else {
        db.interactive_completions.push({
            id: Date.now(),
            user_id: userId,
            interactive_id: interactiveId,
            completed_at: new Date().toISOString(),
            score: isCorrect ? 1 : 0,
            sparks_earned: sparksEarned,
            answer: answer
        });
    }
    
    if (sparksEarned > 0) {
        addSparks(userId, sparksEarned, 'interactive', `Интерактив: ${interactive.title}`);
    }
    
    res.json({
        success: true,
        correct: isCorrect,
        score: isCorrect ? 1 : 0,
        sparksEarned: sparksEarned,
        message: isCorrect ? 
            `Правильно! +${sparksEarned}✨` : 
            'Попробуйте еще раз!'
    });
});

// Admin API
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const stats = {
        totalUsers: db.users.length,
        registeredUsers: db.users.filter(u => u.is_registered).length,
        activeQuizzes: db.quizzes.filter(q => q.is_active).length,
        activeMarathons: db.marathons.filter(m => m.is_active).length,
        shopItems: db.shop_items.filter(i => i.is_active).length,
        totalSparks: db.users.reduce((sum, user) => sum + user.sparks, 0),
        totalAdmins: db.admins.length,
        pendingReviews: db.post_reviews.filter(r => r.status === 'pending').length,
        pendingWorks: db.user_works.filter(w => w.status === 'pending').length,
        totalPosts: db.channel_posts.filter(p => p.is_active).length,
        totalPurchases: db.purchases.length,
        totalActivities: db.activities.length,
        interactives: db.interactives.filter(i => i.is_active).length
    };
    res.json(stats);
});

// Управление интерактивами
app.get('/api/admin/interactives', requireAdmin, (req, res) => {
    const interactives = db.interactives.map(interactive => {
        const completions = db.interactive_completions.filter(ic => ic.interactive_id === interactive.id);
        
        return {
            ...interactive,
            completions_count: completions.length,
            average_score: completions.length > 0 ? 
                completions.reduce((sum, ic) => sum + ic.score, 0) / completions.length : 0
        };
    });
    res.json(interactives);
});

app.post('/api/admin/interactives', requireAdmin, (req, res) => {
    const { title, description, type, category, image_url, question, options, correct_answer, sparks_reward, allow_retake } = req.body;
    
    if (!title || !type || !category) {
        return res.status(400).json({ error: 'Title, type and category are required' });
    }
    
    const newInteractive = {
        id: Date.now(),
        title,
        description: description || '',
        type,
        category,
        image_url: image_url || '',
        question: question || '',
        options: options || [],
        correct_answer: correct_answer || 0,
        sparks_reward: sparks_reward || SPARKS_SYSTEM.INTERACTIVE_COMPLETION,
        allow_retake: allow_retake || false,
        is_active: true,
        created_at: new Date().toISOString()
    };
    
    db.interactives.push(newInteractive);
    
    res.json({ 
        success: true, 
        message: 'Интерактив успешно создан', 
        interactiveId: newInteractive.id,
        interactive: newInteractive
    });
});

app.put('/api/admin/interactives/:interactiveId', requireAdmin, (req, res) => {
    const interactiveId = parseInt(req.params.interactiveId);
    const { title, description, type, category, image_url, question, options, correct_answer, sparks_reward, allow_retake, is_active } = req.body;
    
    const interactive = db.interactives.find(i => i.id === interactiveId);
    if (!interactive) {
        return res.status(404).json({ error: 'Interactive not found' });
    }
    
    if (title) interactive.title = title;
    if (description) interactive.description = description;
    if (type) interactive.type = type;
    if (category) interactive.category = category;
    if (image_url) interactive.image_url = image_url;
    if (question) interactive.question = question;
    if (options) interactive.options = options;
    if (correct_answer !== undefined) interactive.correct_answer = correct_answer;
    if (sparks_reward !== undefined) interactive.sparks_reward = sparks_reward;
    if (allow_retake !== undefined) interactive.allow_retake = allow_retake;
    if (is_active !== undefined) interactive.is_active = is_active;
    
    res.json({ 
        success: true, 
        message: 'Интерактив успешно обновлен',
        interactive: interactive
    });
});

app.delete('/api/admin/interactives/:interactiveId', requireAdmin, (req, res) => {
    const interactiveId = parseInt(req.params.interactiveId);
    const interactiveIndex = db.interactives.findIndex(i => i.id === interactiveId);
    
    if (interactiveIndex === -1) {
        return res.status(404).json({ error: 'Interactive not found' });
    }
    
    db.interactives.splice(interactiveIndex, 1);
    res.json({ success: true, message: 'Интерактив удален' });
});

// Управление ролями
app.get('/api/admin/roles', requireAdmin, (req, res) => {
    res.json(db.roles);
});

app.post('/api/admin/roles', requireAdmin, (req, res) => {
    const { name, description, icon, available_buttons } = req.body;
    
    if (!name || !description) {
        return res.status(400).json({ error: 'Name and description are required' });
    }
    
    const newRole = {
        id: Date.now(),
        name,
        description,
        icon: icon || '🎨',
        available_buttons: available_buttons || ['quiz', 'marathon', 'works', 'activities', 'posts', 'shop', 'invite', 'interactives', 'change_role'],
        is_active: true,
        created_at: new Date().toISOString()
    };
    
    db.roles.push(newRole);
    
    res.json({ 
        success: true, 
        message: 'Роль успешно создана', 
        role: newRole
    });
});

app.put('/api/admin/roles/:roleId', requireAdmin, (req, res) => {
    const roleId = parseInt(req.params.roleId);
    const { name, description, icon, available_buttons, is_active } = req.body;
    
    const role = db.roles.find(r => r.id === roleId);
    if (!role) {
        return res.status(404).json({ error: 'Role not found' });
    }
    
    if (name) role.name = name;
    if (description) role.description = description;
    if (icon) role.icon = icon;
    if (available_buttons) role.available_buttons = available_buttons;
    if (is_active !== undefined) role.is_active = is_active;
    
    res.json({ 
        success: true, 
        message: 'Роль успешно обновлена',
        role: role
    });
});

app.delete('/api/admin/roles/:roleId', requireAdmin, (req, res) => {
    const roleId = parseInt(req.params.roleId);
    const roleIndex = db.roles.findIndex(r => r.id === roleId);
    
    if (roleIndex === -1) {
        return res.status(404).json({ error: 'Role not found' });
    }
    
    const usersWithRole = db.users.filter(u => u.class === db.roles[roleIndex].name);
    if (usersWithRole.length > 0) {
        return res.status(400).json({ error: 'Нельзя удалить роль, у которой есть пользователи' });
    }
    
    db.roles.splice(roleIndex, 1);
    res.json({ success: true, message: 'Роль удалена' });
});

// Управление персонажами
app.get('/api/admin/characters', requireAdmin, (req, res) => {
    const characters = db.characters.map(character => {
        const role = db.roles.find(r => r.id === character.role_id);
        return {
            ...character,
            role_name: role?.name
        };
    });
    res.json(characters);
});

app.post('/api/admin/characters', requireAdmin, (req, res) => {
    const { role_id, name, description, bonus_type, bonus_value } = req.body;
    
    if (!role_id || !name || !bonus_type || !bonus_value) {
        return res.status(400).json({ error: 'Role ID, name, bonus type and value are required' });
    }
    
    const newCharacter = {
        id: Date.now(),
        role_id: parseInt(role_id),
        name,
        description: description || '',
        bonus_type,
        bonus_value,
        is_active: true,
        created_at: new Date().toISOString()
    };
    
    db.characters.push(newCharacter);
    
    res.json({ 
        success: true, 
        message: 'Персонаж успешно создан', 
        character: newCharacter
    });
});

app.put('/api/admin/characters/:characterId', requireAdmin, (req, res) => {
    const characterId = parseInt(req.params.characterId);
    const { name, description, bonus_type, bonus_value, is_active } = req.body;
    
    const character = db.characters.find(c => c.id === characterId);
    if (!character) {
        return res.status(404).json({ error: 'Character not found' });
    }
    
    if (name) character.name = name;
    if (description) character.description = description;
    if (bonus_type) character.bonus_type = bonus_type;
    if (bonus_value) character.bonus_value = bonus_value;
    if (is_active !== undefined) character.is_active = is_active;
    
    res.json({ 
        success: true, 
        message: 'Персонаж успешно обновлен',
        character: character
    });
});

app.delete('/api/admin/characters/:characterId', requireAdmin, (req, res) => {
    const characterId = parseInt(req.params.characterId);
    const characterIndex = db.characters.findIndex(c => c.id === characterId);
    
    if (characterIndex === -1) {
        return res.status(404).json({ error: 'Character not found' });
    }
    
    const usersWithCharacter = db.users.filter(u => u.character_id === characterId);
    if (usersWithCharacter.length > 0) {
        return res.status(400).json({ error: 'Нельзя удалить персонажа, у которого есть пользователи' });
    }
    
    db.characters.splice(characterIndex, 1);
    res.json({ success: true, message: 'Персонаж удален' });
});

// Управление магазином
app.get('/api/admin/shop/items', requireAdmin, (req, res) => {
    res.json(db.shop_items);
});

app.post('/api/admin/shop/items', requireAdmin, (req, res) => {
    console.log('🛒 Создание товара, данные:', {
        title: req.body.title,
        type: req.body.type,
        hasEmbed: !!req.body.embed_html,
        embedLength: req.body.embed_html?.length
    });
    
    const { title, description, type, file_url, preview_url, price, content_text, file_data, preview_data, embed_html } = req.body;
    
    if (!title || !price) {
        return res.status(400).json({ error: 'Title and price are required' });
    }
    
    // Для embed-товаров проверяем наличие HTML
    if (type === 'embed' && !embed_html) {
        return res.status(400).json({ error: 'Для типа "embed" необходимо указать HTML-код' });
    }
    
    const newItem = {
        id: Date.now(),
        title,
        description: description || '',
        type: type || 'video',
        file_url: file_url || file_data || '',
        preview_url: preview_url || preview_data || '',
        price: parseFloat(price),
        content_text: content_text || '',
        embed_html: embed_html || '',
        is_active: true,
        created_at: new Date().toISOString()
    };
    
    console.log('✅ Создан товар:', {
        id: newItem.id,
        type: newItem.type,
        hasEmbed: !!newItem.embed_html,
        embedLength: newItem.embed_html?.length
    });
    
    db.shop_items.push(newItem);
    
    res.json({ 
        success: true, 
        message: 'Товар успешно создан', 
        itemId: newItem.id,
        item: newItem
    });
});

app.put('/api/admin/shop/items/:itemId', requireAdmin, (req, res) => {
    console.log('🛒 Обновление товара, данные:', {
        itemId: req.params.itemId,
        type: req.body.type,
        hasEmbed: !!req.body.embed_html,
        embedLength: req.body.embed_html?.length
    });
    
    const itemId = parseInt(req.params.itemId);
    const { title, description, type, file_url, preview_url, price, content_text, is_active, file_data, preview_data, embed_html } = req.body;
    
    const item = db.shop_items.find(i => i.id === itemId);
    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }
    
    // Для embed-товаров проверяем наличие HTML
    if (type === 'embed' && !embed_html) {
        return res.status(400).json({ error: 'Для типа "embed" необходимо указать HTML-код' });
    }
    
    if (title) item.title = title;
    if (description) item.description = description;
    if (type) item.type = type;
    if (file_url !== undefined) item.file_url = file_url;
    if (file_data !== undefined) item.file_url = file_data;
    if (preview_url !== undefined) item.preview_url = preview_url;
    if (preview_data !== undefined) item.preview_url = preview_data;
    if (price) item.price = parseFloat(price);
    if (content_text) item.content_text = content_text;
    if (embed_html !== undefined) item.embed_html = embed_html;
    if (is_active !== undefined) item.is_active = is_active;
    
    console.log('✅ Обновлен товар:', {
        id: item.id,
        type: item.type,
        hasEmbed: !!item.embed_html,
        embedLength: item.embed_html?.length
    });
    
    res.json({ 
        success: true, 
        message: 'Товар успешно обновлен',
        item: item
    });
});

app.delete('/api/admin/shop/items/:itemId', requireAdmin, (req, res) => {
    const itemId = parseInt(req.params.itemId);
    const itemIndex = db.shop_items.findIndex(i => i.id === itemId);
    
    if (itemIndex === -1) {
        return res.status(404).json({ error: 'Item not found' });
    }
    
    db.shop_items.splice(itemIndex, 1);
    res.json({ success: true, message: 'Товар удален' });
});

// Управление квизами
app.get('/api/admin/quizzes', requireAdmin, (req, res) => {
    const quizzes = db.quizzes.map(quiz => {
        const completions = db.quiz_completions.filter(qc => qc.quiz_id === quiz.id);
        return {
            ...quiz,
            completions_count: completions.length,
            average_score: completions.length > 0 ? 
                completions.reduce((sum, qc) => sum + qc.score, 0) / completions.length : 0
        };
    });
    res.json(quizzes);
});

app.post('/api/admin/quizzes', requireAdmin, (req, res) => {
    const { title, description, questions, sparks_per_correct, sparks_perfect_bonus, cooldown_hours, allow_retake } = req.body;
    
    if (!title || !questions || !Array.isArray(questions)) {
        return res.status(400).json({ error: 'Title and questions array are required' });
    }
    
    const newQuiz = {
        id: Date.now(),
        title,
        description: description || '',
        questions: questions,
        sparks_per_correct: sparks_per_correct || SPARKS_SYSTEM.QUIZ_PER_CORRECT_ANSWER,
        sparks_perfect_bonus: sparks_perfect_bonus || SPARKS_SYSTEM.QUIZ_PERFECT_BONUS,
        cooldown_hours: cooldown_hours || 24,
        allow_retake: allow_retake || true,
        is_active: true,
        created_at: new Date().toISOString()
    };
    
    db.quizzes.push(newQuiz);
    
    res.json({ 
        success: true, 
        message: 'Квиз успешно создан', 
        quizId: newQuiz.id,
        quiz: newQuiz
    });
});

app.put('/api/admin/quizzes/:quizId', requireAdmin, (req, res) => {
    const quizId = parseInt(req.params.quizId);
    const { title, description, questions, sparks_per_correct, sparks_perfect_bonus, cooldown_hours, allow_retake, is_active } = req.body;
    
    const quiz = db.quizzes.find(q => q.id === quizId);
    if (!quiz) {
        return res.status(404).json({ error: 'Quiz not found' });
    }
    
    if (title) quiz.title = title;
    if (description) quiz.description = description;
    if (questions) quiz.questions = questions;
    if (sparks_per_correct !== undefined) quiz.sparks_per_correct = sparks_per_correct;
    if (sparks_perfect_bonus !== undefined) quiz.sparks_perfect_bonus = sparks_perfect_bonus;
    if (cooldown_hours !== undefined) quiz.cooldown_hours = cooldown_hours;
    if (allow_retake !== undefined) quiz.allow_retake = allow_retake;
    if (is_active !== undefined) quiz.is_active = is_active;
    
    res.json({ 
        success: true, 
        message: 'Квиз успешно обновлен',
        quiz: quiz
    });
});

app.delete('/api/admin/quizzes/:quizId', requireAdmin, (req, res) => {
    const quizId = parseInt(req.params.quizId);
    const quizIndex = db.quizzes.findIndex(q => q.id === quizId);
    
    if (quizIndex === -1) {
        return res.status(404).json({ error: 'Quiz not found' });
    }
    
    db.quizzes.splice(quizIndex, 1);
    res.json({ success: true, message: 'Квиз удален' });
});

// Управление марафонами
app.get('/api/admin/marathons', requireAdmin, (req, res) => {
    const marathons = db.marathons.map(marathon => {
        const completions = db.marathon_completions.filter(mc => mc.marathon_id === marathon.id);
        return {
            ...marathon,
            completions_count: completions.length,
            active_users: completions.filter(mc => !mc.completed).length
        };
    });
    res.json(marathons);
});

app.post('/api/admin/marathons', requireAdmin, (req, res) => {
    const { title, description, duration_days, tasks, sparks_per_day } = req.body;
    
    if (!title || !duration_days || !tasks || !Array.isArray(tasks)) {
        return res.status(400).json({ error: 'Title, duration and tasks array are required' });
    }
    
    const newMarathon = {
        id: Date.now(),
        title,
        description: description || '',
        duration_days: parseInt(duration_days),
        tasks: tasks,
        sparks_per_day: sparks_per_day || SPARKS_SYSTEM.MARATHON_DAY_COMPLETION,
        is_active: true,
        created_at: new Date().toISOString()
    };
    
    db.marathons.push(newMarathon);
    
    res.json({ 
        success: true, 
        message: 'Марафон успешно создан', 
        marathonId: newMarathon.id,
        marathon: newMarathon
    });
});

app.put('/api/admin/marathons/:marathonId', requireAdmin, (req, res) => {
    const marathonId = parseInt(req.params.marathonId);
    const { title, description, duration_days, tasks, sparks_per_day, is_active } = req.body;
    
    const marathon = db.marathons.find(m => m.id === marathonId);
    if (!marathon) {
        return res.status(404).json({ error: 'Marathon not found' });
    }
    
    if (title) marathon.title = title;
    if (description) marathon.description = description;
    if (duration_days) marathon.duration_days = parseInt(duration_days);
    if (tasks) marathon.tasks = tasks;
    if (sparks_per_day !== undefined) marathon.sparks_per_day = sparks_per_day;
    if (is_active !== undefined) marathon.is_active = is_active;
    
    res.json({ 
        success: true, 
        message: 'Марафон успешно обновлен',
        marathon: marathon
    });
});

app.delete('/api/admin/marathons/:marathonId', requireAdmin, (req, res) => {
    const marathonId = parseInt(req.params.marathonId);
    const marathonIndex = db.marathons.findIndex(m => m.id === marathonId);
    
    if (marathonIndex === -1) {
        return res.status(404).json({ error: 'Marathon not found' });
    }
    
    db.marathons.splice(marathonIndex, 1);
    res.json({ success: true, message: 'Марафон удален' });
});

app.post('/api/admin/user-works/:workId/moderate', requireAdmin, (req, res) => {
    const workId = parseInt(req.params.workId);
    const { status, admin_comment } = req.body;
    const adminId = req.admin.user_id;
    
    const work = db.user_works.find(w => w.id === workId);
    if (!work) {
        return res.status(404).json({ error: 'Work not found' });
    }
    
    work.status = status;
    work.moderated_at = new Date().toISOString();
    work.moderator_id = adminId;
    work.admin_comment = admin_comment || null;
    
    if (status === 'approved') {
        addSparks(work.user_id, SPARKS_SYSTEM.WORK_APPROVED, 'work_approved', `Работа одобрена: ${work.title}`);
    }
    
    res.json({ 
        success: true, 
        message: `Работа ${status === 'approved' ? 'одобрена' : 'отклонена'}`,
        work: work
    });
});
// ✅ УПРОЩЕННАЯ ФУНКЦИЯ ПОКУПКИ ПРИВАТНОГО ВИДЕО
app.post('/api/webapp/private-videos/purchase', (req, res) => {
    try {
        const { userId, videoId } = req.body;
        
        console.log('🛒 Покупка приватного материала:', { userId, videoId });

        if (!userId || !videoId) {
            return res.status(400).json({ 
                success: false,
                error: 'User ID and video ID are required' 
            });
        }

        const user = db.users.find(u => u.user_id == userId);
        const video = db.private_channel_videos.find(v => v.id == videoId && v.is_active);

        if (!user) {
            return res.status(404).json({ 
                success: false,
                error: 'Пользователь не найден' 
            });
        }
        
        if (!video) {
            return res.status(404).json({ 
                success: false,
                error: 'Материал не найден или неактивен' 
            });
        }

        // Проверяем баланс
        if (user.sparks < video.price) {
            return res.status(400).json({ 
                success: false,
                error: `Недостаточно искр. Нужно: ${video.price}✨, у вас: ${user.sparks.toFixed(1)}✨` 
            });
        }

        // Проверяем, не куплен ли уже материал
        const existingPurchase = db.purchases.find(p => 
            p.user_id == userId && 
            p.item_id == videoId && 
            p.item_type === 'private_video'
        );

        if (existingPurchase) {
            return res.status(400).json({ 
                success: false,
                error: 'У вас уже есть доступ к этому материалу' 
            });
        }

        // ВСЕ ОПЕРАЦИИ В ОДНОЙ ТРАНЗАКЦИИ
        const oldSparks = user.sparks;
        
        // 1. Списание искр
        user.sparks = Number((user.sparks - video.price).toFixed(1));
        
        // 2. Создание записи о покупке
        const purchase = {
            id: Date.now(),
            user_id: parseInt(userId),
            item_id: parseInt(videoId),
            item_type: 'private_video',
            item_title: video.title,
            price_paid: video.price,
            purchased_at: new Date().toISOString()
        };
        db.purchases.push(purchase);

        // 3. Запись активности списания
        const activity = {
            id: Date.now(),
            user_id: userId,
            activity_type: 'private_video_purchase',
            sparks_earned: -video.price,
            description: `Покупка доступа к материалу: ${video.title}`,
            old_balance: oldSparks,
            new_balance: user.sparks,
            created_at: new Date().toISOString()
        };
        db.activities.push(activity);

        console.log(`✅ ПОКУПКА МАТЕРИАЛА УСПЕШНА: ${video.title}`);
        console.log(`   Пользователь: ${userId}`);
        console.log(`   Списано: ${video.price}✨`);
        console.log(`   Баланс: ${oldSparks} → ${user.sparks}✨`);

        res.json({
            success: true,
            purchase: purchase,
            remaining_sparks: user.sparks,
            invite_link: video.invite_link, // Возвращаем прямую ссылку
            message: `✅ Доступ к "${video.title}" успешно приобретен! Нажмите "Перейти к материалу" для вступления в канал.`
        });

    } catch (error) {
        console.error('❌ Ошибка покупки приватного материала:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка при покупке доступа к материалу' 
        });
    }
});
// GET /api/webapp/private-videos/:videoId/new-invite
app.get('/api/webapp/private-videos/:videoId/new-invite', async (req, res) => {
    try {
        const { videoId } = req.params;
        const { userId } = req.query;
        
        console.log('🔄 Запрос новой инвайт-ссылки:', { videoId, userId });

        // Проверяем доступ
        const hasAccess = db.video_access.some(access => 
            access.user_id == userId && 
            access.video_id === parseInt(videoId) && 
            access.expires_at > new Date().toISOString()
        );

        if (!hasAccess) {
            return res.json({ 
                success: false, 
                error: 'Нет доступа к этому материалу' 
            });
        }

        const video = db.private_channel_videos.find(v => v.id === parseInt(videoId));
        if (!video) {
            return res.json({ 
                success: false, 
                error: 'Материал не найден' 
            });
        }

        // Создаем новую инвайт-ссылку
        const inviteResult = await createPrivateInviteLink(video.channel_id, userId);
        
        if (inviteResult.success) {
            res.json({
                success: true,
                invite_link: inviteResult.invite_link,
                video_title: video.title,
                message: 'Новая пригласительная ссылка создана'
            });
        } else {
            res.json({
                success: false,
                error: 'Не удалось создать пригласительную ссылку'
            });
        }

    } catch (error) {
        console.error('❌ Ошибка создания новой ссылки:', error);
        res.json({ 
            success: false, 
            error: 'Ошибка сервера' 
        });
    }
});

// Управление постами
app.get('/api/admin/channel-posts', requireAdmin, (req, res) => {
    const posts = db.channel_posts.map(post => {
        const admin = db.admins.find(a => a.user_id === post.admin_id);
        const reviews = db.post_reviews.filter(r => r.post_id === post.post_id);
        return {
            ...post,
            admin_username: admin?.username,
            reviews_count: reviews.length
        };
    }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    res.json({ posts });
});

app.post('/api/admin/channel-posts', requireAdmin, (req, res) => {
    const { post_id, title, content, image_url, video_url, media_type, action_type, action_target } = req.body;
    
    if (!post_id || !title) {
        return res.status(400).json({ error: 'Post ID and title are required' });
    }
    
    const existingPost = db.channel_posts.find(p => p.post_id === post_id);
    if (existingPost) {
        return res.status(400).json({ error: 'Post with this ID already exists' });
    }
    
    const newPost = {
        id: Date.now(),
        post_id,
        title,
        content: content || '',
        image_url: image_url || '',
        video_url: video_url || '',
        media_type: media_type || 'text',
        admin_id: req.admin.user_id,
        created_at: new Date().toISOString(),
        is_active: true,
        telegram_message_id: null,
        action_type: action_type || null,
        action_target: action_target || null
    };
    
    db.channel_posts.push(newPost);
    
    res.json({ 
        success: true, 
        message: 'Пост успешно создан', 
        postId: newPost.id,
        post: newPost
    });
});

app.put('/api/admin/channel-posts/:postId', requireAdmin, (req, res) => {
    const postId = parseInt(req.params.postId);
    const { title, content, image_url, video_url, media_type, is_active, action_type, action_target } = req.body;
    
    const post = db.channel_posts.find(p => p.id === postId);
    if (!post) {
        return res.status(404).json({ error: 'Post not found' });
    }
    
    if (title) post.title = title;
    if (content) post.content = content;
    if (image_url) post.image_url = image_url;
    if (video_url) post.video_url = video_url;
    if (media_type) post.media_type = media_type;
    if (is_active !== undefined) post.is_active = is_active;
    if (action_type !== undefined) post.action_type = action_type;
    if (action_target !== undefined) post.action_target = action_target;
    
    res.json({ 
        success: true, 
        message: 'Пост успешно обновлен',
        post: post
    });
});

app.delete('/api/admin/channel-posts/:postId', requireAdmin, (req, res) => {
    const postId = parseInt(req.params.postId);
    const postIndex = db.channel_posts.findIndex(p => p.id === postId);
    
    if (postIndex === -1) {
        return res.status(404).json({ error: 'Post not found' });
    }
    
    db.channel_posts.splice(postIndex, 1);
    res.json({ success: true, message: 'Пост удален' });
});

// Управление отзывами
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
    const { status = 'pending' } = req.query;
    
    const reviews = db.post_reviews
        .filter(r => r.status === status)
        .map(review => {
            const user = db.users.find(u => u.user_id === review.user_id);
            const post = db.channel_posts.find(p => p.post_id === review.post_id);
            const moderator = db.admins.find(a => a.user_id === review.moderator_id);
            return {
                ...review,
                tg_first_name: user?.tg_first_name,
                tg_username: user?.tg_username,
                post_title: post?.title,
                moderator_username: moderator?.username
            };
        })
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    
    res.json({ reviews });
});

app.post('/api/admin/reviews/:reviewId/moderate', requireAdmin, (req, res) => {
    const reviewId = parseInt(req.params.reviewId);
    const { status, admin_comment } = req.body;
    
    const review = db.post_reviews.find(r => r.id === reviewId);
    if (!review) {
        return res.status(404).json({ error: 'Review not found' });
    }
    
    review.status = status;
    review.moderated_at = new Date().toISOString();
    review.moderator_id = req.admin.user_id;
    review.admin_comment = admin_comment || null;
    
    res.json({ 
        success: true, 
        message: `Отзыв ${status === 'approved' ? 'одобрен' : 'отклонен'}`,
        review: review
    });
});

// Управление админами
app.get('/api/admin/admins', requireAdmin, (req, res) => {
    res.json(db.admins);
});

app.post('/api/admin/admins', requireAdmin, (req, res) => {
    const { user_id, username, role } = req.body;
    
    if (!user_id) {
        return res.status(400).json({ error: 'User ID is required' });
    }
    
    const existingAdmin = db.admins.find(a => a.user_id == user_id);
    if (existingAdmin) {
        return res.status(400).json({ error: 'Admin already exists' });
    }
    
    const newAdmin = {
        id: Date.now(),
        user_id: parseInt(user_id),
        username: username || '',
        role: role || 'moderator',
        created_at: new Date().toISOString()
    };
    
    db.admins.push(newAdmin);
    
    res.json({ 
        success: true, 
        message: 'Админ успешно добавлен',
        admin: newAdmin
    });
});

app.delete('/api/admin/admins/:userId', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    
    if (userId === req.admin.user_id) {
        return res.status(400).json({ error: 'Cannot remove yourself' });
    }
    
    const adminIndex = db.admins.findIndex(a => a.user_id === userId);
    if (adminIndex === -1) {
        return res.status(404).json({ error: 'Admin not found' });
    }
    
    db.admins.splice(adminIndex, 1);
    res.json({ success: true, message: 'Админ удален' });
});

// Отчет по пользователям
app.get('/api/admin/users-report', requireAdmin, (req, res) => {
    const users = db.users
        .filter(u => u.is_registered)
        .map(user => {
            const stats = getUserStats(user.user_id);
            const works = db.user_works.filter(w => w.user_id === user.user_id);
            const quizCompletions = db.quiz_completions.filter(q => q.user_id === user.user_id);
            const marathonCompletions = db.marathon_completions.filter(m => m.user_id === user.user_id);
            const interactiveCompletions = db.interactive_completions.filter(i => i.user_id === user.user_id);
            
            const totalActivities = 
                quizCompletions.length + 
                marathonCompletions.filter(m => m.completed).length + 
                interactiveCompletions.length + 
                works.length;
            
            return {
                id: user.user_id,
                name: user.tg_first_name,
                username: user.tg_username,
                role: user.class,
                character: user.character_name,
                sparks: user.sparks,
                level: user.level,
                total_quizzes: quizCompletions.length,
                total_marathons: marathonCompletions.filter(m => m.completed).length,
                total_interactives: interactiveCompletions.length,
                total_works: works.length,
                approved_works: works.filter(w => w.status === 'approved').length,
                total_activities: totalActivities,
                registration_date: user.registration_date,
                last_active: user.last_active
            };
        })
        .sort((a, b) => b.total_activities - a.total_activities);
    
    res.json({ users });
});

// Полная статистика
app.get('/api/admin/full-stats', requireAdmin, (req, res) => {
    const stats = {
        users: {
            total: db.users.length,
            registered: db.users.filter(u => u.is_registered).length,
            by_role: db.roles.map(role => ({
                role: role.name,
                count: db.users.filter(u => u.class === role.name).length
            })),
            active_today: db.users.filter(u => {
                const today = new Date();
                const lastActive = new Date(u.last_active);
                return lastActive.toDateString() === today.toDateString();
            }).length
        },
        content: {
            quizzes: db.quizzes.length,
            marathons: db.marathons.length,
            shop_items: db.shop_items.length,
            posts: db.channel_posts.length,
            interactives: db.interactives.length
        },
        activities: {
            total_sparks: db.users.reduce((sum, user) => sum + user.sparks, 0),
            total_purchases: db.purchases.length,
            total_works: db.user_works.length,
            pending_moderation: {
                works: db.user_works.filter(w => w.status === 'pending').length,
                reviews: db.post_reviews.filter(r => r.status === 'pending').length
            }
        },
        completions: {
            quizzes: db.quiz_completions.length,
            marathons: db.marathon_completions.filter(m => m.completed).length,
            interactives: db.interactive_completions.length
        }
    };
    
    res.json(stats);
});

// ==================== ЭНДПОИНТЫ СТАТИСТИКИ ПОЛЬЗОВАТЕЛЯ ====================

app.get('/api/users/:userId/stats', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        console.log('📊 Запрос статистики для пользователя:', userId);

        const user = db.users.find(u => u.user_id === userId);
        if (!user) {
            return res.status(404).json({ 
                success: false,
                error: 'User not found' 
            });
        }

        // Собираем полную статистику
        const stats = {
            totalQuizzesCompleted: db.quiz_completions.filter(q => q.user_id === userId).length,
            totalWorks: db.user_works.filter(w => w.user_id === userId).length,
            approvedWorks: db.user_works.filter(w => w.user_id === userId && w.status === 'approved').length,
            totalMarathonsCompleted: db.marathon_completions.filter(m => m.user_id === userId && m.completed).length,
            totalInteractivesCompleted: db.interactive_completions.filter(i => i.user_id === userId).length,
            totalActivities: db.activities.filter(a => a.user_id === userId).length,
            totalPurchases: db.purchases.filter(p => p.user_id === userId).length,
            totalSparksEarned: db.activities
                .filter(a => a.user_id === userId && a.sparks_earned > 0)
                .reduce((sum, a) => sum + a.sparks_earned, 0),
            totalSparksSpent: Math.abs(db.activities
                .filter(a => a.user_id === userId && a.sparks_earned < 0)
                .reduce((sum, a) => sum + a.sparks_earned, 0)),
            registrationDate: user.registration_date,
            lastActive: user.last_active
        };

        console.log('✅ Статистика отправлена для пользователя:', userId);
        res.json({
            success: true,
            stats: stats
        });

    } catch (error) {
        console.error('❌ Ошибка получения статистики:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка сервера'
        });
    }
});

// ✅ ENDPOINT ДЛЯ ВЕРСИИ ПРИЛОЖЕНИЯ
app.get('/api/app/version', (req, res) => {
    res.json({
        version: '1.0.0',
        changelog: 'Первоначальный релиз',
        timestamp: new Date().toISOString()
    });
});

// ✅ ENDPOINT ДЛЯ АНАЛИТИКИ
app.post('/api/analytics/track', (req, res) => {
    // Просто логируем аналитику, но не сохраняем в базу
    console.log('📊 Analytics:', req.body);
    res.json({ success: true });
});

// ==================== ЭКСПОРТ ОТЧЕТОВ ====================

// Экспорт пользователей в CSV с правильной кодировкой
app.get('/api/admin/export/users', requireAdmin, (req, res) => {
    try {
        console.log('👥 Экспорт пользователей в CSV');
        
        const users = db.users.filter(u => u.is_registered);
        
        // Создаем CSV с BOM для правильной кодировки
        let csv = '\uFEFF'; // BOM для UTF-8
        
        // Заголовки на русском
        csv += 'ID;Имя;Username;Роль;Персонаж;Уровень;Искры;Зарегистрирован;Последняя активность\n';
        
        // Данные пользователей
        users.forEach(user => {
            const row = [
                user.user_id,
                `"${user.tg_first_name || 'Неизвестно'}"`,
                `"${user.tg_username || 'нет'}"`,
                `"${user.class || 'Не выбрана'}"`,
                `"${user.character_name || 'Не выбран'}"`,
                `"${user.level || 'Ученик'}"`,
                user.sparks.toFixed(1),
                `"${new Date(user.registration_date).toLocaleDateString('ru-RU')}"`,
                `"${new Date(user.last_active).toLocaleDateString('ru-RU')}"`
            ].join(';');
            
            csv += row + '\n';
        });
        
        // Устанавливаем правильные заголовки
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="users_export.csv"');
        res.send(csv);
        
        console.log('✅ Пользователи экспортированы с правильной кодировкой');
        
    } catch (error) {
        console.error('❌ Ошибка экспорта пользователей:', error);
        res.status(500).json({ error: 'Ошибка экспорта данных' });
    }
});

// Экспорт статистики в CSV с правильной кодировкой
app.get('/api/admin/export/full-stats', requireAdmin, (req, res) => {
    try {
        console.log('📈 Экспорт полной статистики в CSV');
        
        const users = db.users.filter(u => u.is_registered);
        const purchases = db.purchases;
        const activities = db.activities;
        const works = db.user_works;
        const quizCompletions = db.quiz_completions;
        const marathonCompletions = db.marathon_completions.filter(m => m.completed);
        
        // Статистика по ролям
        const roleStats = {};
        db.roles.forEach(role => {
            roleStats[role.name] = users.filter(u => u.class === role.name).length;
        });
        
        // Создаем CSV с BOM для правильного отображения кириллицы в Excel
        let csv = '\uFEFF'; // BOM для UTF-8
        csv += 'Раздел;Показатель;Значение\n';
        
        // Основная статистика
        csv += `Пользователи;Всего пользователей;${users.length}\n`;
        csv += `Пользователи;Зарегистрировано;${users.filter(u => u.is_registered).length}\n`;
        csv += `Пользователи;Активных сегодня;${users.filter(u => {
            const today = new Date();
            const lastActive = new Date(u.last_active);
            return lastActive.toDateString() === today.toDateString();
        }).length}\n`;
        
        // Статистика по ролям
        Object.keys(roleStats).forEach(role => {
            csv += `Роли;${role};${roleStats[role]}\n`;
        });
        
        // Активности
        csv += `Активности;Всего активностей;${activities.length}\n`;
        csv += `Активности;Всего искр в системе;${users.reduce((sum, user) => sum + user.sparks, 0).toFixed(1)}\n`;
        csv += `Активности;Всего покупок;${purchases.length}\n`;
        csv += `Активности;Всего работ;${works.length}\n`;
        csv += `Активности;Одобренных работ;${works.filter(w => w.status === 'approved').length}\n`;
        
        // Завершения
        csv += `Завершения;Пройдено квизов;${quizCompletions.length}\n`;
        csv += `Завершения;Завершено марафонов;${marathonCompletions.length}\n`;
        
        // Контент
        csv += `Контент;Активных квизов;${db.quizzes.filter(q => q.is_active).length}\n`;
        csv += `Контент;Активных марафонов;${db.marathons.filter(m => m.is_active).length}\n`;
        csv += `Контент;Товаров в магазине;${db.shop_items.filter(i => i.is_active).length}\n`;
        csv += `Контент;Постов в канале;${db.channel_posts.filter(p => p.is_active).length}\n`;
        csv += `Контент;Интерактивов;${db.interactives.filter(i => i.is_active).length}\n`;
        
        // Устанавливаем правильные заголовки для CSV с кириллицей
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="full_stats_${new Date().toISOString().split('T')[0]}.csv"`);
        
        res.send(csv);
        
        console.log('✅ Статистика экспортирована с правильной кодировкой');
        
    } catch (error) {
        console.error('❌ Ошибка экспорта статистики:', error);
        res.status(500).json({ error: 'Ошибка экспорта статистики' });
    }
});

// Оптимизированные API для мобильных устройств
app.get('/api/webapp/mobile/shop/items', async (req, res) => {
    try {
        const items = db.shop_items.filter(item => item.is_active);
        
        // Для мобильных - ограничиваем данные и убираем тяжелый контент
        const mobileItems = items.map(item => ({
            id: item.id,
            title: item.title,
            description: item.description,
            type: item.type,
            preview_url: item.preview_url,
            price: item.price,
            // Исключаем большие поля для мобильных
            content_text: req.isMobile ? (item.content_text?.substring(0, 100) + '...') : item.content_text,
            embed_html: null, // Не отправляем embed на мобильные
            is_active: item.is_active
        }));
        
        res.json(mobileItems);
    } catch (error) {
        console.error('❌ Ошибка загрузки магазина для мобильных:', error);
        res.status(500).json({ error: 'Ошибка загрузки товаров' });
    }
});

// ✅ ПРОСТОЙ ENDPOINT ДЛЯ ПРИВАТНЫХ ВИДЕО
app.get('/api/webapp/private-videos', (req, res) => {
    try {
        const userId = parseInt(req.query.userId);
        console.log('🎬 Запрос приватных материалов для пользователя:', userId);

        const videos = db.private_channel_videos.filter(video => video.is_active);
        
        const videosWithAccess = videos.map(video => {
            // Проверяем покупку
            const hasPurchase = db.purchases.some(purchase => 
                purchase.user_id == userId && 
                purchase.item_id === video.id && 
                purchase.item_type === 'private_video'
            );

            return {
                id: video.id,
                invite_link: video.invite_link, // Убедитесь, что ссылка передается
                title: video.title,
                description: video.description,
                duration: video.duration,
                price: video.price,
                category: video.category,
                level: video.level,
                has_access: hasPurchase,
                has_purchase: hasPurchase,
                can_purchase: !hasPurchase
            };
        });

        console.log(`✅ Найдено материалов: ${videosWithAccess.length}`);
        console.log('🔗 Первая ссылка:', videosWithAccess[0]?.invite_link);

        res.json({ 
            success: true,
            videos: videosWithAccess 
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения приватных материалов:', error);
        res.status(500).json({ 
            success: false,
            error: 'Ошибка загрузки материалов' 
        });
    }
});

// Оптимизированные интерактивы для мобильных
app.get('/api/webapp/mobile/interactives', async (req, res) => {
    try {
        const interactives = db.interactives.filter(i => i.is_active);
        
        const mobileInteractives = interactives.map(interactive => ({
            id: interactive.id,
            title: interactive.title,
            description: interactive.description,
            type: interactive.type,
            category: interactive.category,
            image_url: interactive.image_url,
            question: interactive.question,
            sparks_reward: interactive.sparks_reward,
            allow_retake: interactive.allow_retake,
            // Упрощаем для мобильных
            options: interactive.options || [],
            correct_answer: interactive.correct_answer,
            is_active: interactive.is_active
        }));
        
        res.json(mobileInteractives);
    } catch (error) {
        console.error('❌ Ошибка загрузки интерактивов для мобильных:', error);
        res.status(500).json({ error: 'Ошибка загрузки интерактивов' });
    }
});

// Health check для мобильных
app.get('/api/mobile/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        mobile: true,
        timestamp: new Date().toISOString(),
        optimized: true
    });
});

// ==================== ИСПРАВЛЕННАЯ СИСТЕМА TELEGRAM БОТА ====================

let bot;

async function initializeBot() {
    try {
        if (!process.env.BOT_TOKEN) {
            console.log('⚠️ Токен бота не настроен, бот не будет запущен');
            return;
        }

        console.log('🤖 Инициализация Telegram бота как Web App...');
        
        bot = new TelegramBot(process.env.BOT_TOKEN, {
            polling: {
                interval: 300,
                autoStart: true,
                params: {
                    timeout: 10
                }
            }
        });

        console.log('✅ Telegram Bot создан');

        // Настройка Web App кнопки
        await setupWebAppButton();

        // Упрощенные обработчики
        setupWebAppHandlers();

        console.log('✅ Бот настроен как Web App');
        console.log('🎯 Теперь в каналах будет кнопка для перехода в приложение!');

    } catch (error) {
        console.error('💥 Ошибка инициализации бота:', error);
    }
}

// Настройка обработчиков команд
function setupBotHandlers() {
    if (!bot) {
        console.error('❌ Бот не инициализирован');
        return;
    }

    // ОБНОВЛЕННЫЙ ОБРАБОТЧИК /start
bot.onText(/\/start/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const firstName = msg.from.first_name || 'Друг';
        const chatType = msg.chat.type; // 'private', 'group', 'supergroup', 'channel'

        console.log(`👋 Команда /start от ${firstName} (${userId}) в чате типа: ${chatType}`);

        // РАЗНЫЕ СООБЩЕНИЯ ДЛЯ РАЗНЫХ КОНТЕКСТОВ
        if (chatType === 'private') {
            // ЛИЧНЫЕ СООБЩЕНИЯ - ПОЛНАЯ ФУНКЦИОНАЛЬНОСТЬ
            await handlePrivateStart(chatId, userId, firstName, msg);
        } else {
            // ГРУППЫ И КАНАЛЫ - ТОЛЬКО КНОПКА ПРИЛОЖЕНИЯ
            await handleChannelStart(chatId, userId, firstName, msg);
        }

    } catch (error) {
        console.error('❌ Ошибка обработки /start:', error);
    }
});

// Функция настройки Web App кнопки
async function setupWebAppButton() {
    try {
        if (!TELEGRAM_BOT_TOKEN) return;

        // Устанавливаем Web App как основную кнопку меню
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                menu_button: {
                    type: 'web_app',
                    text: '🎨 Мастерская',
                    web_app: {
                        url: process.env.APP_URL || 'https://yourdomain.com'
                    }
                }
            })
        });
        
        const result = await response.json();
        if (result.ok) {
            console.log('✅ Web App кнопка установлена для всех чатов');
        } else {
            console.log('⚠️ Не удалось установить Web App кнопку:', result.description);
        }

    } catch (error) {
        console.error('❌ Ошибка настройки Web App кнопки:', error);
    }
}
    
// ✅ ИСПРАВЛЕННЫЙ TELEGRAM БОТ
async function handlePrivateStart(chatId, userId, firstName, msg) {
    try {
        // Проверяем существующего пользователя
        let user = db.users.find(u => u.user_id === userId);
        const username = msg.from.username || `user_${userId}`;
        
        if (!user) {
            // СОЗДАЕМ НОВОГО ПОЛЬЗОВАТЕЛЯ, НО НЕ РЕГИСТРИРУЕМ ПОЛНОСТЬЮ
            user = {
                id: Date.now(),
                user_id: userId,
                tg_first_name: firstName,
                tg_username: username,
                sparks: 0, // Пока 0, пока не зарегистрируется
                level: 'Ученик',
                is_registered: false, // Еще не выбрал роль
                class: null,
                character_id: null,
                character_name: null,
                available_buttons: [],
                registration_date: new Date().toISOString(),
                last_active: new Date().toISOString()
            };
            db.users.push(user);
            console.log(`✅ Новый пользователь создан (ожидает регистрацию): ${firstName}`);
        }

        const welcomeText = `🎨 Привет, ${firstName}!

Добро пожаловать в **Мастерскую Вдохновения**!

✨ Я ваш помощник в мире творчества. 

${!user.is_registered ? 
    '📝 *Для начала работы нужно завершить регистрацию* - выберите свою творческую роль в приложении.' : 
    `✅ *Вы уже зарегистрированы как ${user.class}*`
}

💡 *Что вас ждет:*
• 🎯 Квизы и тесты по искусству
• 🏃‍♂️ Творческие марафоны  
• 🖼️ Галерея ваших работ
• 🛒 Магазин знаний
• 🎬 Эксклюзивные материалы

*Ваш текущий баланс:* ${user.sparks.toFixed(1)}✨
*Уровень:* ${user.level}`;

        const appUrl = `${process.env.APP_URL || 'http://localhost:3000'}?tgWebAppStartParam=${userId}`;
        
        const keyboard = {
            inline_keyboard: [[
                {
                    text: user.is_registered ? "📱 Открыть Личный Кабинет" : "🚀 Начать Регистрацию",
                    web_app: { url: appUrl }
                }
            ]]
        };

        await bot.sendMessage(chatId, welcomeText, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

    } catch (error) {
        console.error('❌ Ошибка обработки /start:', error);
    }
}

// ДЛЯ КАНАЛОВ И ГРУПП
async function handleChannelStart(chatId, userId, firstName, msg) {
    const appUrl = `${process.env.APP_URL || 'http://localhost:3000'}?tgWebAppStartParam=${userId}`;
    
    const keyboard = {
        inline_keyboard: [[
            {
                text: "🎨 Открыть Мастерскую Вдохновения",
                web_app: { url: appUrl }
            }
        ]]
    };

    await bot.sendMessage(chatId, 
        `🎨 *Мастерская Вдохновения*\n\nПривет, ${firstName}! Нажмите кнопку ниже чтобы открыть творческое приложение:`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
}
    // Обработчик команды /profile
    bot.onText(/\/profile/, async (msg) => {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            const firstName = msg.from.first_name || 'Пользователь';

            console.log(`👤 Команда /profile от ${firstName} (${userId})`);

            const user = db.users.find(u => u.user_id === userId);
            if (!user) {
                await bot.sendMessage(chatId, 
                    '❌ Ваш профиль не найден. Используйте /start для начала работы.'
                );
                return;
            }

            const stats = getUserStats(userId);
            const profileText = `👤 *Ваш профиль*

*Имя:* ${user.tg_first_name}
*Уровень:* ${user.level}
*Искры:* ${user.sparks.toFixed(1)}✨
*Роль:* ${user.class || 'Не выбрана'}
*Персонаж:* ${user.character_name || 'Не выбран'}

*📊 Статистика:*
• Пройдено квизов: ${stats.totalQuizzesCompleted}
• Загружено работ: ${stats.totalWorks}
• Завершено марафонов: ${stats.totalMarathonsCompleted}
• Пройдено интерактивов: ${stats.totalInteractivesCompleted}

💡 Используйте /stats для подробной статистики`;

            await bot.sendMessage(chatId, profileText, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('❌ Ошибка обработки /profile:', error);
        }
    });

    // Обработчик команды /stats
    bot.onText(/\/stats/, async (msg) => {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            console.log(`📊 Команда /stats от пользователя ${userId}`);

            // Проверяем права администратора
            const admin = db.admins.find(a => a.user_id == userId);
            if (!admin) {
                await bot.sendMessage(chatId, 
                    '❌ У вас нет прав доступа к этой команде.'
                );
                return;
            }

            const stats = {
                totalUsers: db.users.length,
                registeredUsers: db.users.filter(u => u.is_registered).length,
                activeQuizzes: db.quizzes.filter(q => q.is_active).length,
                activeMarathons: db.marathons.filter(m => m.is_active).length,
                shopItems: db.shop_items.filter(i => i.is_active).length,
                totalSparks: db.users.reduce((sum, user) => sum + user.sparks, 0),
                privateVideos: db.private_channel_videos.filter(v => v.is_active).length,
                videoAccesses: db.video_access.length,
                totalActivities: db.activities.length,
                totalPurchases: db.purchases.length
            };
            
            const statsText = `📊 *Статистика бота*

👥 *Пользователи:*
• Всего: ${stats.totalUsers}
• Зарегистрировано: ${stats.registeredUsers}

🎯 *Контент:*
• Активных квизов: ${stats.activeQuizzes}
• Активных марафонов: ${stats.activeMarathons}
• Товаров в магазине: ${stats.shopItems}
• Приватных видео: ${stats.privateVideos}

💰 *Экономика:*
• Всего искр в системе: ${stats.totalSparks.toFixed(1)}✨
• Активных доступов: ${stats.videoAccesses}
• Всего покупок: ${stats.totalPurchases}
• Всего активностей: ${stats.totalActivities}

🔄 *Последнее обновление:* ${new Date().toLocaleString('ru-RU')}`;

            await bot.sendMessage(chatId, statsText, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('❌ Ошибка обработки /stats:', error);
        }
    });

    // Обработчик команды /admin
    bot.onText(/\/admin/, async (msg) => {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            console.log(`🔧 Команда /admin от пользователя ${userId}`);

            const admin = db.admins.find(a => a.user_id == userId);
            if (!admin) {
                await bot.sendMessage(chatId, 
                    '❌ У вас нет прав доступа к админ панели.'
                );
                return;
            }

            const adminUrl = `${process.env.APP_URL || 'http://localhost:3000'}/admin.html?userId=${userId}`;
            
            const keyboard = {
                inline_keyboard: [[
                    {
                        text: "🔧 Открыть Админ Панель",
                        url: adminUrl
                    }
                ]]
            };
            
            await bot.sendMessage(chatId, 
                `🔧 *Панель администратора*\n\nНажмите кнопку ниже чтобы открыть админ панель:`, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            console.error('❌ Ошибка обработки /admin:', error);
        }
    });

    // Обработчик команды /help
    bot.onText(/\/help/, async (msg) => {
        try {
            const chatId = msg.chat.id;
            const firstName = msg.from.first_name || 'Друг';

            const helpText = `🆘 *Помощь по боту*

*Основные команды:*
/start - Начать работу с ботом
/profile - Показать ваш профиль
/help - Показать эту справку

*Для администраторов:*
/stats - Статистика бота
/admin - Открыть админ панель

*Доступ к материалам:*
Используйте кнопку "Личный кабинет" для доступа ко всем функциям:
• 🎯 Квизы и тесты
• 🏃‍♂️ Творческие марафоны
• 🖼️ Галерея работ
• 🛒 Магазин знаний
• 🎬 Приватные видео

💡 *Совет:* Большинство функций доступно через веб-приложение в личном кабинете.

📧 *Поддержка:* Если у вас есть вопросы, обратитесь к администратору.`;

            await bot.sendMessage(chatId, helpText, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('❌ Ошибка обработки /help:', error);
        }
    });

// ОБРАБОТЧИК ДЛЯ КНОПКИ "ОТКРЫТЬ ПРИЛОЖЕНИЕ" ИЗ КАНАЛА
bot.onText(/\/app/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const firstName = msg.from.first_name || 'Друг';

        console.log(`📱 Команда /app от ${firstName} (${userId})`);

        // СОЗДАЕМ ИЛИ ОБНОВЛЯЕМ ПОЛЬЗОВАТЕЛЯ
        let user = db.users.find(u => u.user_id === userId);
        if (!user) {
            user = {
                id: Date.now(),
                user_id: userId,
                tg_first_name: firstName,
                tg_username: msg.from.username || `user_${userId}`,
                sparks: 10,
                level: 'Ученик',
                is_registered: false,
                class: null,
                character_id: null,
                character_name: null,
                available_buttons: [],
                registration_date: new Date().toISOString(),
                last_active: new Date().toISOString()
            };
            db.users.push(user);
            console.log(`✅ Новый пользователь из канала: ${firstName}`);
        }

        const appUrl = `${process.env.APP_URL || 'http://localhost:3000'}?tgWebAppStartParam=${userId}`;
        
        const keyboard = {
            inline_keyboard: [[
                {
                    text: "🚀 Открыть Приложение",
                    web_app: { url: appUrl }
                }
            ]]
        };

        await bot.sendMessage(chatId, 
            `🎨 *Добро пожаловать в Мастерскую Вдохновения!*\n\nПривет, ${firstName}! Нажмите кнопку ниже чтобы открыть приложение и начать творческий путь:`, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

    } catch (error) {
        console.error('❌ Ошибка обработки /app:', error);
    }
});

// ... остальной код бота ...

    // Обработчик текстовых сообщений (не команд)
    bot.on('message', async (msg) => {
        // Игнорируем команды (они обрабатываются отдельно)
        if (msg.text && msg.text.startsWith('/')) {
            return;
        }

        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            const text = msg.text;

            // Простой эхо-ответ на текстовые сообщения
            if (text && text.trim().length > 0) {
                await bot.sendMessage(chatId, 
                    `🤖 Я получил ваше сообщение: "${text}"\n\nИспользуйте /help для просмотра доступных команд.`, {
                    reply_to_message_id: msg.message_id
                });
            }

        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error);
        }
    });

    // Обработчик ошибок бота
    bot.on('polling_error', (error) => {
        console.error('❌ Ошибка polling бота:', error.code, error.message);
    });

    bot.on('webhook_error', (error) => {
        console.error('❌ Ошибка webhook бота:', error);
    });

    bot.on('error', (error) => {
        console.error('❌ Общая ошибка бота:', error);
    });

    console.log('✅ Все обработчики команд настроены');
    console.log('🎯 Бот готов к работе!');
}

// Функция отправки уведомлений
async function sendTelegramNotification(userId, message, options = {}) {
    try {
        if (!TELEGRAM_BOT_TOKEN) {
            console.error('❌ Токен бота не настроен для отправки уведомления');
            return false;
        }

        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: userId,
                text: message,
                parse_mode: 'HTML',
                ...options
            })
        });

        const result = await response.json();
        
        if (result.ok) {
            console.log(`✅ Уведомление отправлено пользователю ${userId}`);
            return true;
        } else {
            console.error(`❌ Ошибка отправки уведомления пользователю ${userId}:`, result.description);
            return false;
        }

    } catch (error) {
        console.error(`💥 Критическая ошибка отправки уведомления пользователю ${userId}:`, error.message);
        return false;
    }
}

// ==================== СИСТЕМА МОНИТОРИНГА И ЛОГИРОВАНИЯ ====================

// ✅ СИСТЕМА МОНИТОРИНГА ДЛЯ ПРОДАКШЕНА
function logSystemStatus() {
    console.log('\n📊 === СИСТЕМНЫЙ СТАТУС ===');
    console.log(`👥 Пользователей: ${db.users.length}`);
    console.log(`   ✅ Зарегистрировано: ${db.users.filter(u => u.is_registered).length}`);
    console.log(`   ⏳ Ожидают регистрации: ${db.users.filter(u => !u.is_registered).length}`);
    console.log(`💰 Всего искр в системе: ${db.users.reduce((sum, user) => sum + user.sparks, 0).toFixed(1)}✨`);
    console.log(`🛒 Покупок совершено: ${db.purchases.length}`);
    console.log(`📈 Активностей записано: ${db.activities.length}`);
    console.log(`🔧 Админов: ${db.admins.length}`);
    console.log('============================\n');
}

// Запускаем мониторинг каждые 5 минут
setInterval(logSystemStatus, 5 * 60 * 1000);

// ==================== ПРОВЕРОЧНЫЕ ЭНДПОИНТЫ ====================

// ✅ ПРОВЕРОЧНЫЕ ЭНДПОИНТЫ
app.get('/api/system/health', (req, res) => {
    res.json({
        status: 'OK',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        database: 'In-Memory',
        users: {
            total: db.users.length,
            registered: db.users.filter(u => u.is_registered).length,
            total_sparks: db.users.reduce((sum, user) => sum + user.sparks, 0).toFixed(1)
        },
        content: {
            quizzes: db.quizzes.filter(q => q.is_active).length,
            marathons: db.marathons.filter(m => m.is_active).length,
            shop_items: db.shop_items.filter(i => i.is_active).length,
            interactives: db.interactives.filter(i => i.is_active).length
        },
        timestamp: new Date().toISOString()
    });
});

// ✅ ДОПОЛНИТЕЛЬНЫЙ ДЕБАГ ЭНДПОИНТ
app.get('/api/system/debug', (req, res) => {
    const recentUsers = db.users
        .sort((a, b) => new Date(b.registration_date) - new Date(a.registration_date))
        .slice(0, 10)
        .map(u => ({
            id: u.user_id,
            name: u.tg_first_name,
            registered: u.is_registered,
            role: u.class,
            sparks: u.sparks,
            level: u.level,
            last_active: u.last_active
        }));
    
    const recentActivities = db.activities
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 10);
    
    res.json({
        recent_users: recentUsers,
        recent_activities: recentActivities,
        pending_transactions: Array.from(pendingTransactions.entries()),
        completed_transactions: Array.from(completedTransactions.entries())
    });
});

// ==================== ЗАПУСК СЕРВЕРА ====================

// Запуск сервера с управлением процессами
async function startServer() {
    try {
        // Настраиваем управление процессами
        await setupProcessManagement();
        
        const PORT = process.env.PORT || 3000;
        
        // Запускаем сервер
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Сервер запущен на порту ${PORT}`);
            console.log(`📱 WebApp: ${process.env.APP_URL || `http://localhost:${PORT}`}`);
            console.log(`🔧 Admin: ${process.env.APP_URL || `http://localhost:${PORT}`}/admin`);
            console.log(`🏥 Health: ${process.env.APP_URL || `http://localhost:${PORT}`}/api/system/health`);
            
            // Первый статус при запуске
            logSystemStatus();
        });
        
        // Настраиваем graceful shutdown
        setupGracefulShutdown(server);
        
        // Инициализируем Telegram бота
        await initializeBot();
        
        return server;
        
    } catch (error) {
        console.error('💥 Критическая ошибка запуска:', error);
        process.exit(1);
    }
}

// ЗАПУСКАЕМ ПРИЛОЖЕНИЕ
startServer().catch(error => {
    console.error('💥 Критическая ошибка запуска:', error);
    process.exit(1);
});

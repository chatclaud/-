# ChatClaud — деплой

Весь проект лежит в корне: `server.js` и `package.json` рядом, папка `modules/` обязательна.

## Render / Railway
- Root Directory: пусто (корень репозитория)
- Build: `npm install`   Start: `npm start`
- Health: `/api/health`

## Переменные окружения (точные имена)
GROQ_KEY, GROQ_MODEL=openai/gpt-oss-120b,
MISTRAL_API_KEY, MISTRAL_MODEL=mistral-small-latest,
NOVA_URL, NOVA_API_TOKEN, TAVILY_API_KEY
`https://chatclaud.github.io` разрешён сервером по умолчанию. Для другого frontend-домена добавь его точный origin в `CORS_ORIGINS` (без пути `/` или `/-/`).
Старые написания MINSTRAL_AIP_KEY, NOVA_AIP_TOKEN, TAVILY_AIP сервер тоже понимает.

## Проверка
`/api/health` → hasGroq, hasMistral, hasNova, hasTavily = true.

## Сайт
Сервер сам отдаёт сайт (index.html). Адрес сервера в сайте: `https://chatclaud.onrender.com`
(строка `var def = ...` в начале index.html; для проверки можно открыть `?api=https://ДРУГОЙ-АДРЕС`).


Диагностика: в этой версии `GET /api/health` публичный и должен возвращать JSON с `ok: true`. Если опубликованный Render URL отвечает `forbidden`, проверь Root Directory, ветку/коммит и Start Command: запущенная версия не совпадает с этим файлом либо запрос попадает в другой сервис.

# Clarity

Современный Minecraft-сервер с пустынным (desert) биомом.
Минимализм, премиум-дизайн, честная экономика.

## Страницы
- `index.html` — Главная
- `donate.html` — Донат
- `discord.html` — Discord
- `about.html` — О сервере
- `social.html` — Соцсети
- `history.html` — История

## Backend
`server.js` — Express-сервер: приём донатов через DonationAlerts webhook,
выдача привилегий через RCON/LuckPerms, Telegram Login верификация.

```
npm install
npm start
```

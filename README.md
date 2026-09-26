# Авторизация клуба «Фабрика заготовок»

Ветка auth/prodamus переводит сайт из статического режима в ONREZA Compute. Продамус присылает оплату на POST /api/webhooks/prodamus; сервер проверяет заголовок Sign, добавляет или продлевает email в PostgreSQL, а клиент получает одноразовую magic-ссылку. Сессия хранится в PostgreSQL и httpOnly-cookie.

## Переменные окружения

Добавьте в настройки проекта DATABASE_URL, PRODAMUS_SECRET_KEY, RESEND_API_KEY, AUTH_FROM_EMAIL и PUBLIC_URL. Ключи и токены не добавляйте в GitHub.

## Продамус

URL уведомлений: https://club-fabrika-zagotovok-kozlovheritage.onreza.app/api/webhooks/prodamus

Для подписок тот же URL нужно указать отдельно в разделе «Подписки». В ссылке или настройках платежной страницы должен использоваться согласованный с Продамусом sys. Для возврата после успешной оплаты установите urlSuccess: https://club-fabrika-zagotovok-kozlovheritage.onreza.app/?paid=1

urlSuccess только возвращает браузер на сайт. Право доступа выдаёт исключительно подписанный webhook.

## ONREZA

Проект должен собираться как Compute и запускаться командой npm start. Сервер слушает process.env.PORT и 0.0.0.0.

Перед production проверьте тестовым webhook из кабинета Продамуса: HTTP 200, запись email в club_users, отправку magic-ссылки, одноразовость ссылки, повторный вход после logout и отказ webhook с неверным Sign.

# Talent Forge Membership Funnel

## Files
- `public/index.html` — updated responsive landing page, Page 2 membership view, animated sections, five membership levels, brochure PDF download and enquiry form.
- `server.js` — Express API, SQLite persistence and automatic email notifications.
- `.env.example` — SMTP and deployment settings.

## Run locally
1. Install Node.js (LTS).
2. Open this folder in VS Code.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Set `EMAIL_USER` and `EMAIL_PASS`. For Gmail, create and use a Google App Password.
6. Confirm `EMPLOYEE_EMAIL`, `SALES_PAGE_URL` and `ADMIN_DASHBOARD_URL`.
7. Run `npm start`.
8. Open `http://localhost:5000`.

## Email workflow
The API inserts the lead into SQLite first. Only after the insert succeeds does it attempt:
- Employee notification to Yasaswini.
- Executive notification to `santhan@alphaauron.com`.
- Prospect acknowledgement to the submitted email address, including the Page 2 URL and Lead ID.

Email failures are written to `email_logs`; a failed email does not erase the saved enquiry. This starter does not yet implement automatic retry scheduling, a central CRM integration, role-secured admin dashboard or Excel synchronisation. Those need to be connected before production deployment.

## Important deployment notes
- Do not commit `.env` or expose SMTP credentials in frontend JavaScript.
- Set `SALES_PAGE_URL` to the actual deployed Page 2 URL. In this starter, Page 2 is the `#page2` view of the same HTML page.
- Set `ADMIN_DASHBOARD_URL` to a real authenticated admin route. Do not use a guessed URL.
- Add rate limiting, CSRF/origin controls, spam protection, authentication and role-based access before production.
- Verify the supplied plan values and project-value illustrations with the company's approved official terms before publishing.

## Success animation, dashboards and login (added)
- Submit Enquiry shows an animated success tick and the thank-you message once the server confirms the save.
- `#yasaswini` opens the Yasaswini login and dashboard; `#admin` opens the Admin login and dashboard (stats, search, status updates; Admin also gets the email delivery log and CSV export).
- Add to `.env`: `YASASWINI_USERNAME`, `YASASWINI_PASSWORD`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET` (see `.env.example`). The server will not start without them.
- Emails (prospect confirmation, Yasaswini notification, executive copy) are sent right after the enquiry is saved; each result is recorded in `email_logs`.
- No new npm packages are needed.
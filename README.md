# Skating School Portal

Standalone hockey skating-school management app.

## Core features
- Parent/player contacts with DOB, birth year, skill level and notes
- Programs and recurring sessions
- Full-time, drop-in and wait-list enrollment
- Attendance request links with Attending / Not Attending / No Reply tracking
- Wait-list availability messaging
- Calendar view
- Parent-declared payment method (E-transfer / Cash)
- Admin payment status (Owing / Paid / Partial / Complimentary)
- Private email/SMS targeting by program, DOB year, skill, enrollment and attendance state
- Custom contact groups

## Local setup
1. `npm install`
2. Copy `.env.example` to `.env`
3. Set `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `JWT_SECRET`
4. `npm start`
5. Open `/admin.html`

Database tables are created automatically on startup.

## Messaging
Email and SMS are optional. Without provider credentials, the portal still creates attendance links and shows the exact recipient list, but sending returns a configuration warning.

### Email
Set `RESEND_API_KEY` and `EMAIL_FROM`.

### SMS
Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.

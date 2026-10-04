# Grace Life Hospital

A hospital website for a fictional hospital in Jonesboro, Arkansas, built for a student project.
It is plain TypeScript with no framework: a Node server and browser code that compiles to ES modules.

## Features

- **Patient chat assistant.** Answers come from Claude (the AI model) through the server, so the API key never reaches the browser. If the AI is unavailable, the chat answers from built-in hospital information instead.
- **Emergency detection.** Messages that mention things like chest pain or trouble breathing immediately show call buttons for 911 and the ER, before any AI reply. Mentions of suicide or self-harm show the 988 crisis line.
- **Live staff handoff.** A visitor can ask for a person. Staff then reply from a hidden console on the same site, and the bot stops answering in that chat.
- **Responsive design.** The site has a photo gallery, animated stats, live "open now" hours in Central Time, and a mobile menu.

## Running it

Requires Node 22.9 or newer.

```bash
npm install
cp .env.example .env    # then fill in ADMIN_PASSWORD (8+ characters)
npm run build
npm start               # http://localhost:8080
```

`ANTHROPIC_API_KEY` is optional. Without it, the chat runs on the built-in answers only.

## Staff console

The console is hidden from visitors. To open the staff sign-in, do any of these:

- click the footer copyright line 5 times quickly
- press **Alt + Shift + A**
- go to `/#staff`

The password is checked on the server, and the staff session is kept in an httpOnly cookie that page scripts can't read.

## Project layout

```
src/shared/   used by both browser and server: hospital info, emergency detection, offline answers, message types
src/server/   HTTP server, chat API, staff API, live updates (server-sent events), conversation storage
src/client/   page behaviour, visitor chat, staff console
public/       index.html and images (compiled JS goes to public/js)
```

## Credits

The photos are openly licensed (CC BY). Their credits are in the site footer.
Doctor portraits are illustrative only and do not show real staff of this fictional hospital.

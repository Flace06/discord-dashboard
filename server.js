services:
  - type: web
    name: discord-dashboard
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 10000
      - key: CLIENT_ID
        sync: false          # Im Render-Dashboard eintragen
      - key: CLIENT_SECRET
        sync: false          # Im Render-Dashboard eintragen
      - key: BOT_TOKEN
        sync: false          # Im Render-Dashboard eintragen
      - key: SESSION_SECRET
        generateValue: true  # Render generiert automatisch einen sicheren Wert
      - key: REDIRECT_URI
        sync: false          # z.B. https://discord-dashboard-xyz.onrender.com/auth/callback

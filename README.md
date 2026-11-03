# Deploy (Railway / Render)

1. इस फोल्डर को GitHub पर डालो (cookies.txt कभी नहीं, .gitignore में है)।
2. कुकीज़ दो में से एक तरीके से:
   - **Env var (आसान):** `base64 -w0 cookies.txt` का आउटपुट `COOKIES_B64` नाम से डालो।
   - **Secret file (Render):** `cookies.txt` को Secret File बनाओ (path: /etc/secrets/cookies.txt)।
3. Dockerfile अपने-आप पहचान लिया जाएगा। Port 3000।

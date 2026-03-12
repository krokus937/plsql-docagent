# ⚡ PL/SQL DocAgent

> Documenta automáticamente tu código PL/SQL con Claude AI y publica en GitHub Pages con un solo `git push`.

![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?logo=vite&logoColor=white)
![React](https://img.shields.io/badge/React-18.x-61DAFB?logo=react&logoColor=black)
![Claude AI](https://img.shields.io/badge/Claude-Sonnet_4-orange?logo=anthropic)
![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub_Pages-blue?logo=github)

---

## 🖥️ Demo en vivo

Una vez desplegado, tu app estará disponible en:
```
https://<TU-USUARIO>.github.io/<NOMBRE-REPO>/
```

---

## 📋 Características

- 📁 **Carga de archivos** — arrastra tu `.sql` o pégalo directamente
- 🤖 **IA real** — conecta con Claude Sonnet via API Key de Anthropic
- ⚡ **Streaming en tiempo real** — ve la documentación generarse token a token  
- 📄 **Markdown completo** — procedures, functions, ejemplos, dependencias, índice
- 🐙 **Publicación directa en GitHub** — guarda el `.md` en cualquier repo con un clic
- 📱 **Totalmente responsive** — desktop, tablet y móvil

---

## 🚀 Instalación y deploy en GitHub Pages

### Requisitos previos

| Herramienta | Versión mínima | Verificar |
|-------------|----------------|-----------|
| Node.js     | 18.x o superior | `node -v` |
| npm         | 9.x o superior  | `npm -v`  |
| Git         | cualquiera      | `git -v`  |
| Cuenta GitHub | — | [github.com](https://github.com) |

---

### Paso 1 — Clonar / descargar el proyecto

**Opción A — Si ya tienes el repositorio clonado:**
```bash
cd plsql-docagent
```

**Opción B — Crear desde cero:**
```bash
# Crea la carpeta y copia todos los archivos del proyecto
mkdir plsql-docagent && cd plsql-docagent
```

---

### Paso 2 — Instalar dependencias

```bash
npm install
```

Esto instalará: React 18, Vite 5, y el plugin `gh-pages`.

---

### Paso 3 — Probar en local

```bash
npm run dev
```

Abre tu navegador en `http://localhost:5173` — deberías ver el agente funcionando.

---

### Paso 4 — Crear el repositorio en GitHub

1. Ve a [github.com/new](https://github.com/new)
2. Dale un nombre, por ejemplo: `plsql-docagent`
3. Deja el resto por defecto y haz clic en **Create repository**

---

### Paso 5 — Configurar el nombre del repositorio en Vite

Abre `vite.config.js` y actualiza el campo `base` con el nombre **exacto** de tu repositorio:

```js
// vite.config.js
export default defineConfig({
  plugins: [react()],
  base: '/plsql-docagent/',   // ← Cambia esto por tu nombre de repo
})
```

> ⚠️ **Importante:** El valor de `base` debe coincidir exactamente con el nombre de tu repositorio en GitHub, incluyendo las barras `/`.

---

### Paso 6 — Subir el código a GitHub

```bash
# Inicializar git (si aún no lo has hecho)
git init
git add .
git commit -m "feat: initial commit — PL/SQL DocAgent"

# Conectar con tu repositorio de GitHub
git remote add origin https://github.com/TU-USUARIO/plsql-docagent.git

# Subir a la rama main
git branch -M main
git push -u origin main
```

---

### Paso 7 — Activar GitHub Pages con GitHub Actions

1. Ve a tu repositorio en GitHub
2. Abre **Settings** → **Pages** (en el menú lateral izquierdo)
3. En **Source**, selecciona: `GitHub Actions`

   ![GitHub Pages Settings](https://docs.github.com/assets/cb-28360/mw-1440/images/help/pages/pages-source-deploy-select.webp)

4. Haz clic en **Save**

---

### Paso 8 — Disparar el primer deploy

El workflow se ejecuta automáticamente en cada `push` a `main`. Para verificar:

1. Ve a la pestaña **Actions** de tu repositorio
2. Verás el workflow `Deploy PL/SQL DocAgent to GitHub Pages` ejecutándose
3. Espera que el semáforo se ponga verde ✅ (tarda ~1-2 minutos)

```bash
# También puedes forzar un nuevo deploy con un push vacío:
git commit --allow-empty -m "chore: trigger deploy"
git push
```

---

### Paso 9 — Acceder a tu app

Una vez completado el deploy, tu app estará disponible en:

```
https://TU-USUARIO.github.io/plsql-docagent/
```

GitHub también te muestra la URL en **Settings → Pages**.

---

## 🔧 Comandos disponibles

```bash
npm run dev      # Servidor de desarrollo local (puerto 5173)
npm run build    # Genera la carpeta dist/ para producción
npm run preview  # Preview del build de producción en local
npm run deploy   # Build + deploy manual con gh-pages (alternativo al CI)
```

---

## 🔑 Obtener tu API Key de Anthropic

1. Crea una cuenta en [console.anthropic.com](https://console.anthropic.com)
2. Ve a **Settings → API Keys**
3. Haz clic en **Create Key**
4. Copia la key — empieza con `sk-ant-api03-...`

> 💡 La key se guarda en `sessionStorage` del navegador (no en disco, no en el código). Se borra al cerrar la pestaña.

---

## 📁 Estructura del proyecto

```
plsql-docagent/
├── .github/
│   └── workflows/
│       └── deploy.yml          # 🤖 CI/CD automático para GitHub Pages
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   ├── MarkdownRenderer.jsx # 📄 Renderizador de Markdown
│   │   └── GitHubModal.jsx      # 🐙 Modal para publicar en GitHub
│   ├── constants/
│   │   └── systemPrompt.js      # 🧠 Prompt del agente PL/SQL
│   ├── App.jsx                  # 🏠 Componente principal
│   ├── App.css                  # 🎨 Estilos responsive
│   └── main.jsx                 # ⚡ Entry point
├── index.html                   # 📝 HTML base
├── vite.config.js               # ⚙️ Configuración de Vite
├── package.json
└── README.md
```

---

## 🐛 Solución de problemas comunes

### La app carga pero se ve en blanco
→ Verifica que el valor de `base` en `vite.config.js` coincide exactamente con el nombre de tu repo.

### Error `403` al publicar en GitHub
→ Tu Personal Access Token necesita el permiso `repo` (no solo `public_repo`). Crea uno nuevo en [github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo).

### Error de CORS al llamar a la API de Anthropic
→ Es normal en algunos navegadores con extensiones de seguridad. Desactiva temporalmente las extensiones o usa un perfil limpio.

### El workflow de GitHub Actions falla
→ Revisa la pestaña **Actions** para ver el error exacto. Los más comunes son:
- `npm ci` falla → ejecuta `npm install` y sube el `package-lock.json`
- Permisos de Pages → asegúrate de haber seleccionado `GitHub Actions` en Settings → Pages

---

## 🤝 Contribuciones

Pull requests bienvenidos. Para cambios grandes, abre primero un issue.

---

## 📝 Licencia

MIT — libre para uso personal y comercial.

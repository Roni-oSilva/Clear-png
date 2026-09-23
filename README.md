# ClearCut — Remoção de fundo com IA

Aplicação web completa para remover o fundo de imagens com IA **local** (Rembg + ONNX Runtime).
Frontend em HTML5 + Tailwind CSS + JavaScript moderno; backend em Python com FastAPI.

## Estrutura

```
clearcut/
├── backend/
│   ├── app/
│   │   ├── main.py              # API FastAPI, erros amigáveis, serve o frontend
│   │   ├── config.py            # Configuração por variáveis de ambiente
│   │   ├── ai/engine.py         # Motor de IA (rembg) — sessão única, thread-safe
│   │   └── services/
│   │       ├── validation.py    # Tamanho, formato real (magic bytes), integridade
│   │       └── storage.py       # Pastas temporárias por pedido + limpeza automática
│   │   ├── ai/lite_engine.py    # Motor leve (ONNX Runtime puro) para 512 MB de RAM
│   ├── requirements.txt         # Completo (rembg) — uso local
│   └── requirements-render.txt  # Mínimo (motor lite) — Render gratuito
├── frontend/
│   ├── index.html               # UI (Tailwind)
│   ├── assets/config.js         # Endereço da API (preencha para a Vercel)
│   ├── assets/app.js            # Upload, progresso, comparador, exportação
│   ├── assets/orb.js            # Esfera neural 3D interativa (Canvas, sem dependências)
│   ├── assets/styles.css        # Animações e componentes
│   └── tailwind/                # Build de produção do Tailwind (opcional)
├── render.yaml                  # Blueprint do Render (plano gratuito)
├── .env.example
├── run.sh / run.bat             # Arranque num comando
└── Dockerfile
```

## Requisitos

- **Python 3.10 – 3.12**
- RAM: ~1 GB para imagens normais; **~2 GB por imagem em processamento** perto do limite de 100 MB / 100 MP (com `MAX_CONCURRENT_JOBS=2`, conte com ~4 GB)
- Ligação à internet **apenas na primeira execução** (download do modelo para `~/.u2net`)

## Executar localmente

### Opção A — um comando

```bash
# Linux / macOS
./run.sh

# Windows
run.bat
```

### Opção B — passo a passo

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Abra **http://localhost:8000** — o backend serve também o frontend (sem problemas de CORS).

> Na primeira execução o servidor descarrega o modelo (~180 MB). Aguarde a mensagem
> `Modelo 'isnet-general-use' pronto.` no terminal.

### Opção C — Docker

```bash
docker build -t clearcut .
docker run -p 8000:8000 clearcut
```

## API

### `POST /api/remove-background`

`multipart/form-data`

| Campo          | Tipo    | Descrição                                           |
|----------------|---------|-----------------------------------------------------|
| `file`         | ficheiro| PNG, JPG ou WebP (máx. `MAX_UPLOAD_MB`, padrão 100 MB) |
| `refine_edges` | boolean | Ativa *alpha matting* para cabelo/pelo (mais lento) |

**200** → `image/png` (RGBA, resolução original). Cabeçalhos: `X-Processing-Time`, `X-Image-Width`, `X-Image-Height`, `X-Refine-Applied` (`false` quando a imagem passa de `MAX_REFINE_PIXELS`).

O upload é gravado em disco em blocos de 1 MB — a memória do servidor não cresce com o tamanho do ficheiro recebido.

**Lotes:** o frontend processa até `MAX_BATCH_FILES` (5) imagens por vez, enviando-as para este mesmo endpoint numa fila com 2 pedidos em paralelo. O ZIP final é montado no navegador.

**Erros** (sempre JSON):

```json
{ "error": { "code": "corrupted_image", "message": "Não foi possível ler a imagem..." } }
```

| Código HTTP | `code`                                  |
|-------------|-----------------------------------------|
| 400         | `empty_file`, `corrupted_image`         |
| 413         | `file_too_large`, `too_many_pixels`     |
| 415         | `unsupported_format`                    |
| 422         | `missing_file`, `processing_failed`     |
| 500         | `internal_error`                        |

```bash
curl -F "file=@foto.jpg" -F "refine_edges=true" http://localhost:8000/api/remove-background -o resultado.png
```

### `GET /api/health`
Estado do servidor, modelo ativo e limites (usado pelo frontend para sincronizar o tamanho máximo).

## Privacidade e ficheiros temporários

1. Cada pedido recebe uma pasta própria com nome UUID em `backend/tmp/` (permissões `700`).
2. O original é apagado logo após a inferência; a pasta inteira é apagada **assim que a resposta é enviada**.
3. Uma rotina de fundo remove qualquer resto com mais de `FILE_TTL_SECONDS` (padrão: 5 min) — cobre quedas de ligação.
4. A pasta é esvaziada no arranque e no encerramento do servidor.
5. A cor de fundo e a exportação final são feitas **no navegador** — nada volta ao servidor.

## Configuração (`.env`)

Copie `.env.example` para `.env` (o `run.sh` carrega-o automaticamente).

| Variável                 | Padrão              | Notas |
|--------------------------|---------------------|-------|
| `ENGINE`                 | `rembg`             | `lite` para servidores com 512 MB (Render gratuito) |
| `MAX_DECODE_PIXELS`      | = `MAX_PIXELS`      | Limite para PNG (Render: 30 MP) |
| `MAX_WEBP_PIXELS`        | = `MAX_DECODE_PIXELS` | Limite para WebP (Render: 16 MP) |
| `MAX_OUTPUT_PIXELS`      | `0` (original)      | Só lite: reduz o PNG final acima disto (Render: 16 MP) |
| `REMBG_MODEL`            | `isnet-general-use` | `birefnet-general` = máxima precisão em cabelo (mais lento/pesado); `u2netp` = mais leve; `birefnet-portrait` = retratos |
| `MAX_UPLOAD_MB`          | `100`               | Tamanho máximo por ficheiro |
| `MAX_PIXELS`             | `100000000`         | 100 MP; proteção contra *decompression bombs* |
| `MAX_REFINE_PIXELS`      | `25000000`          | Acima disto o "refinar bordas" é ignorado (seria lento/pesado) |
| `MAX_BATCH_FILES`        | `5`                 | Imagens por lote no frontend |
| `FILE_TTL_SECONDS`       | `300`               | |
| `MAX_CONCURRENT_JOBS`    | `2`                 | Inferências simultâneas (limita CPU/RAM) |
| `CORS_ORIGINS`           | `*`                 | Ex.: `https://app.exemplo.com` em produção |

**GPU NVIDIA:** troque `rembg[cpu]` por `rembg[gpu]` em `requirements.txt`.

## Deploy gratuito: Vercel (frontend) + Render (backend)

O plano gratuito do Render tem **512 MB de RAM** e menos de meia CPU. O motor normal (`rembg` + IS-Net)
chega a **1,4 GB** numa foto de 12 MP, por isso é derrubado por falta de memória. Para o Render existe o
**motor lite** (`ENGINE=lite`): só ONNX Runtime + NumPy + Pillow, com o modelo `u2netp`.

| Medido (servidor completo) | Motor rembg + IS-Net | Motor lite + u2netp |
|---|---|---|
| Em repouso | ~660 MB | **~100 MB** |
| Pico, foto de 12 MP | ~1 400 MB | **~290 MB** |
| Pior caso (JPEG 88 MB / 95 MP, 10 imagens seguidas) | falha | **~370 MB** |

Como o lite cabe em 512 MB:
- não importa OpenCV/SciPy/scikit-image/numba (só o `import rembg` já ocupa ~220 MB);
- a IA corre numa versão reduzida da imagem e o recorte é aplicado depois — a foto grande e o modelo nunca estão na RAM ao mesmo tempo;
- JPEGs grandes são descodificados já reduzidos (1/2, 1/4, 1/8); PNG até 30 MP e WebP até 16 MP;
- o PNG final vai até 16 MP (fotos maiores são **reduzidas**, não recusadas — a interface avisa "reduzida");
- 1 imagem de cada vez no modelo; os uploads continuam em paralelo (vão para o disco).

**Compromisso:** o `u2netp` é mais leve e um pouco menos preciso que o IS-Net em cabelo e bordas finas.
Para a qualidade máxima: plano com 2 GB (Render Standard) + `ENGINE=lite` e `REMBG_MODEL=isnet-general-use`
(pico ~900 MB), ou o motor `rembg` num PC/servidor próprio.

### 1. Publicar o código no GitHub
Crie um repositório e envie a pasta `clearcut/` (o `.gitignore` já exclui modelos, `.venv`, `tmp`).

### 2. Backend no Render
1. Render → **New → Blueprint** → escolha o repositório. O `render.yaml` já configura tudo
   (plano free, motor lite, limites de memória, health check).
2. Quando pedir `CORS_ORIGINS`, ponha o endereço da Vercel (pode deixar `*` e trocar depois).
3. Aguarde o deploy e abra `https://<o-seu-servico>.onrender.com/api/health` — deve mostrar `"engine":"lite"`.

> Sem Blueprint: **New → Web Service**, runtime Python, plano Free, e use os mesmos
> `buildCommand`, `startCommand` e variáveis de ambiente que estão no `render.yaml`.

### 3. Frontend na Vercel
1. Em `frontend/assets/config.js`, coloque o endereço do Render (sem `/` no fim):
   ```js
   window.APP_CONFIG = { apiBase: 'https://<o-seu-servico>.onrender.com' };
   ```
   Faça commit e push.
2. Vercel → **Add New → Project** → importe o repositório → **Root Directory: `frontend`**,
   Framework Preset **Other**, sem build command → **Deploy**.
3. Volte ao Render e defina `CORS_ORIGINS=https://<o-seu-projeto>.vercel.app` (vários domínios: separe por vírgulas).

> Também funciona **só com o Render**: o backend serve o frontend no mesmo endereço (deixe `apiBase: ''`).

### Particularidades do plano gratuito do Render
- O serviço **adormece após 15 min sem tráfego** e demora ~1 min a acordar. A página mostra
  "A acordar o servidor…" e avisa que o primeiro pedido pode demorar.
- São 750 horas gratuitas por mês por workspace — chega para 1 serviço ligado o mês todo.
- CPU limitada: conte com alguns segundos por imagem (mais em fotos grandes).
- O disco é temporário (é o que queremos: nada fica guardado).

## Frontend num servidor separado

Se servir o `frontend/` noutro domínio/porta (ex.: `npx serve frontend`), edite `frontend/assets/config.js`:

```js
window.APP_CONFIG = { apiBase: 'http://localhost:8000' };
```

## Produção

- **Tailwind:** o CDN é ótimo para desenvolvimento; em produção gere CSS estático:
  ```bash
  cd frontend/tailwind
  npx tailwindcss@3 -c tailwind.config.js -i input.css -o ../assets/tailwind.css --minify
  ```
  Depois, em `index.html`, substitua os dois `<script>` do Tailwind por
  `<link rel="stylesheet" href="assets/tailwind.css" />`.
- Coloque um proxy reverso (Nginx/Caddy) com HTTPS, `client_max_body_size 110m` e `proxy_read_timeout 600s` (imagens grandes demoram mais).
- Use `--workers 1` por processo (cada worker carrega o seu modelo na RAM); escale com mais contentores.
- Considere *rate limiting* (ex.: `slowapi`) se a aplicação for pública.

## Funcionalidades

- Layout em duas colunas: hero com **esfera neural 3D interativa** (arraste para rodar, o cursor repele partículas) e a caixa de upload ao lado
- A esfera reage ao estado: acelera ao arrastar um ficheiro, o "fundo" dissolve-se com o progresso, pulsa a verde no sucesso e treme a vermelho no erro
- Caixa com borda gradiente animada, spotlight que segue o cursor, inclinação 3D e cantos de "scanner"
- **Até 5 imagens de uma vez** (arrastar, selecionar ou colar): lista com miniatura, progresso e estado de cada ficheiro, repetir os que falharem, ver/comparar ou descarregar cada um, e **Descarregar ZIP** com todas (com a cor de fundo escolhida)
- **Ficheiros até 100 MB** cada (testado com JPEG de 88 MB / 95 MP: ~14 s)
- Drag & drop com animações + overlay em toda a janela, clique para escolher, **Ctrl+V** para colar
- Validação no cliente (tipo, tamanho, imagem legível) **e** no servidor (magic bytes, integridade, dimensões)
- Barra de progresso real no upload + progresso estimado durante a inferência, com mensagens por fase
- Cancelamento do processamento
- Comparador antes/depois com slider (rato, toque e teclado ← →), vista lado a lado e só resultado
- Fundo transparente, branco, preto ou cor personalizada
- Download PNG na resolução original (**Ctrl+S**; no lote descarrega o ZIP) e copiar para a área de transferência
- Tema claro/escuro (segue o sistema, com alternância manual), acessível e responsivo

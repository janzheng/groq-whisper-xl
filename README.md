# Groq Whisper XL - Universal Audio Transcription

A high-performance Cloudflare Worker with a beautiful web interface that provides fast, accurate audio transcription using Groq's Whisper API with automatic file handling from small files to 100GB+ enterprise processing.

## Features

- **Beautiful Web Interface** - Drag & drop uploads, real-time streaming, job management
- **Ultra-fast transcription** using Groq's Whisper API
- **Universal file support** - automatically handles any size (MB to 100GB+)
- **Real-time streaming transcription** with live results
- **LLM error correction** for improved accuracy using Llama 3.1 8B
- **Smart job management** with progress tracking
- **Multiple upload methods** - Direct upload, URL download, presigned upload
- **Automatic processing** - chooses optimal strategy based on file size

## Quick Start

### 1. Clone and Setup
```bash
git clone https://github.com/janzheng/groq-whisper-xl
cd groq-whisper-xl
npm install
```

### 2. Build the Web Interface
```bash
npm run build
```

### 3. Deploy to Cloudflare
```bash
# Login and deploy
wrangler login
wrangler deploy

# Create required resources
wrangler r2 bucket create groq-whisper-audio
wrangler kv namespace create "GROQ_JOBS_KV"
```

### 4. Set Environment Variables
```bash
# Set your API key
wrangler secret put GROQ_API_KEY
# Enter your Groq API key when prompted

# Set R2 credentials (get from Cloudflare R2 dashboard)
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID  
wrangler secret put R2_SECRET_ACCESS_KEY
```

### 5. Update wrangler.toml
Copy the KV namespace ID from `wrangler kv namespace list` and update your `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "GROQ_JOBS_KV"
id = "your-actual-kv-namespace-id"
```

### 6. Final Deploy
```bash
npm run deploy
```

After deployment, you'll receive your worker URL (e.g., `https://groq-whisper-xl.your-subdomain.workers.dev`). Use this URL to replace `https://your-worker.workers.dev` in all API examples below.

## API Endpoints

The API automatically handles files of any size - from small audio clips to 100GB+ enterprise files. No special configuration needed; the system detects file size and chooses the optimal processing method. File size limits are determined by Cloudflare's infrastructure capabilities rather than application restrictions.

### Direct Upload
```bash
# Upload and process in one step
curl -X POST https://your-worker.workers.dev/upload \
  -F "file=@audio.mp3" \
  -F "use_llm=true"
```

### URL Upload  
```bash
# Process audio from any URL
curl -X POST https://your-worker.workers.dev/upload-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/podcast.mp3", "use_llm": true}'
```

### Streaming API
```bash
# Real-time streaming transcription
curl -X POST https://your-worker.workers.dev/stream \
  -F "file=@audio.mp3" \
  -F "chunk_size_mb=1" \
  -F "use_llm=true"
```

### Job Management
```bash
# Check status
curl "https://your-worker.workers.dev/status?job_id=<job_id>"

# Get results  
curl "https://your-worker.workers.dev/result?job_id=<job_id>"

# List all jobs
curl "https://your-worker.workers.dev/jobs"
```

## Web Interface

Visit your deployed worker URL to access the beautiful web interface featuring:

### Direct Upload & Processing
- **Drag & drop file upload** - Support for MP3, WAV, M4A, FLAC, etc.
- **URL downloads** - Process audio directly from web URLs
- **LLM correction** - AI-powered transcript improvement
- **Background processing** - Upload and get notified when complete

### Real-time Streaming Transcription  
- **Live results** - See transcription as it happens
- **Configurable chunk sizes** - Balance speed vs API calls (0.25MB - 2MB)
- **LLM modes** - Per-chunk (real-time) or post-process (best quality)
- **Progress tracking** - Visual progress with chunk counter and timing

### Job Management
- **Live job monitoring** - Auto-refreshing job list with status updates
- **Transcript viewing** - Expandable results with copy-to-clipboard
- **Job cleanup** - Delete completed jobs and files
- **Export options** - Copy transcript or full job JSON

## Command Line Interface

For users who prefer terminal-based workflows, the project includes a powerful CLI tool with an interactive menu system. Simply run `npm run cli` to access features like direct upload, URL processing, streaming transcription, and job management - all from your command line.

## Automatic Processing

The system automatically detects file size and chooses the optimal processing method:

| File Size | Method | Features |
|-----------|--------|----------|
| ≤ 15MB | Direct | Immediate results, fastest |
| 15MB - 100MB | Chunked | Progress tracking, LLM correction |
| > 100MB | Advanced Chunking | Distributed processing, monitoring |

## LLM Correction Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Disabled** | Raw Whisper output | Fastest, testing |
| **Per-chunk** | Real-time correction | Streaming, live demos |
| **Post-process** | Full-context correction | Best quality, batch processing |

## Development

### Local Development
```bash
# Start development server with auto-rebuild
npm run dev

# Access at http://localhost:8787
```

### Build Commands
```bash
npm run build         # Build web interface and deploy
npm run build:svelte  # Build Svelte app only
npm run dev:svelte    # Watch Svelte changes
```

### CLI Tool (Optional)
```bash
# Use the command-line interface
npm run cli
```

## Configuration

### Required Environment Variables
```bash
GROQ_API_KEY=your_groq_api_key    # Get from https://console.groq.com/keys
R2_ACCOUNT_ID=your_account_id     # Cloudflare account ID
R2_ACCESS_KEY_ID=your_access_key  # R2 API token
R2_SECRET_ACCESS_KEY=your_secret  # R2 API secret
```

### Optional Variables
```bash
ALLOWED_ORIGINS=https://yourdomain.com,http://localhost:3000
MAX_FILE_SIZE=107374182400  # 100GB default
```

## Supported Formats

- **Audio**: MP3, WAV, FLAC, M4A, OGG, AAC, WMA
- **Video**: MP4, MPEG, WEBM (audio track extracted)
- **Size**: Limited by Cloudflare's infrastructure (100GB+ files supported with automatic chunking)

## Example Usage

### Web Interface Workflow
1. **Visit your worker URL** - Access the web interface
2. **Choose upload method** - Direct upload or streaming transcription
3. **Drag & drop your file** - Or enter a URL to download
4. **Configure settings** - Enable LLM correction, set chunk size
5. **Start transcription** - Monitor progress in real-time
6. **View results** - Copy transcript or download full results

### API Workflow  
1. **Upload**: POST to `/upload` with your file
2. **Monitor**: GET `/status?job_id=<id>` to check progress  
3. **Results**: GET `/result?job_id=<id>` when complete

## Features

- **Automatic retries** with exponential backoff
- **Circuit breaker** protection against API failures  
- **CORS protection** for web interface security
- **File cleanup** - Automatic expiration after 24 hours
- **Health monitoring** - `/health` endpoint for status checks

## License

This project is open sourced and licensed under the MIT License - see the LICENSE file for details.

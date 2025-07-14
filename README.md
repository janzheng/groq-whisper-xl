# Groq Whisper XL - Universal Audio Transcription

A high-performance Cloudflare Worker that provides a unified API for Groq's Whisper speech-to-text service with automatic scaling from small files to 100GB+ enterprise processing.

## ✨ Features

- 🚀 **Ultra-fast transcription** using Groq's Whisper API
- 📁 **Universal file support** - automatically handles any size (MB to 100GB+)
- 🎯 **Smart tier detection** - Standard, Advanced, and Enterprise processing
- 🔄 **Automatic retry logic** with exponential backoff
- 🛡️ **Circuit breaker** protection against service failures
- 🤖 **LLM error correction** for large files using Llama 3.1 8B Instant
- 📊 **Real-time progress tracking** with job management
- 🌐 **Translation support** to English
- ⏱️ **Word-level timestamps** and segment metadata
- 🖥️ **Beautiful unified interface** - one interface for all file sizes
- 💰 **Cost estimation** and controls
- 📈 **Health monitoring** and service status

## 🎯 Processing Tiers

The system automatically detects file size and routes to the appropriate processing tier:

| Tier | File Size | Processing Method | Features |
|------|-----------|-------------------|----------|
| **Standard** | ≤ 15MB | Direct processing | Immediate results, fastest |
| **Advanced** | 15MB - 100MB | Intelligent chunking | Job tracking, progress updates, LLM correction |
| **Enterprise** | > 100MB | Distributed processing | Advanced chunking, LLM correction, monitoring |

## 🎤 Supported Models

| Model | Cost/Hour | Languages | Translation | Speed | Accuracy |
|-------|-----------|-----------|-------------|-------|----------|
| `whisper-large-v3` | $0.111 | Multilingual | ✅ | 217x | Highest |
| `whisper-large-v3-turbo` | $0.04 | Multilingual | ❌ | 228x | High |
| `distil-whisper-large-v3-en` | $0.02 | English only | ❌ | 250x | Good |

## 🚀 Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd groq-whisper-xl
npm install
```

**Note**: The project includes an `example.wav` file for testing the transcription functionality.

### 2. Initial Worker Setup

First, let's create the worker and do an initial deployment:

```bash
# Login to Cloudflare (if not already logged in)
wrangler login

# Do an initial deployment to create the worker
wrangler deploy
```

This creates the worker in Cloudflare and gives you a URL like `https://groq-whisper-xl.your-subdomain.workers.dev`

### 3. Configure Cloudflare Resources

Now that the worker exists, create the required resources:

```bash
# Create R2 bucket
wrangler r2 bucket create groq-whisper-audio

# Create KV namespace for job tracking and file metadata
wrangler kv namespace create "GROQ_JOBS_KV"

# List KV namespaces to get the IDs
wrangler kv namespace list
```

### 4. Update wrangler.toml

Update the `wrangler.toml` file with the actual namespace IDs from the previous step:

```toml
[[kv_namespaces]]
binding = "GROQ_JOBS_KV"                 # Stores job status, progress, and file metadata
id = "your-actual-kv-namespace-id"        # Copy from 'wrangler kv namespace list'
preview_id = "your-actual-preview-kv-namespace-id"  # Copy from 'wrangler kv namespace list'
```

**What does GROQ_JOBS_KV store?**
- 📊 **Job tracking**: Status, progress, and results for large file processing
- 📁 **File metadata**: Upload information, file sizes, and processing tiers
- 🔄 **Active jobs**: List of currently processing jobs for monitoring
- 📈 **Progress data**: Real-time progress updates for chunked processing

### 5. Set Environment Variables

Now that the worker exists, you can set environment variables using **three methods**:

#### Option 1: Cloudflare Dashboard (Recommended for Production)

1. **Go to Cloudflare Dashboard**:
   - Visit [dash.cloudflare.com](https://dash.cloudflare.com)
   - Navigate to **Workers & Pages** → **groq-whisper-xl** → **Settings** → **Variables**

2. **Add Environment Variables**:
   - Click **"Add variable"**
   - Add each variable:
     ```
     GROQ_API_KEY = your_groq_api_key_here
     ALLOWED_ORIGINS = https://yourdomain.com,http://localhost:3000
     ```
   - Click **"Encrypt"** for sensitive variables like API keys
   - Click **"Save and deploy"**

#### Option 2: Wrangler CLI (Recommended for Development)

```bash
# Set secrets (encrypted variables) - worker must exist first
wrangler secret put GROQ_API_KEY
# Enter your API key when prompted

wrangler secret put ALLOWED_ORIGINS
# Enter your origins when prompted

# Or set multiple at once
echo "your_groq_api_key_here" | wrangler secret put GROQ_API_KEY
echo "https://yourdomain.com,http://localhost:3000" | wrangler secret put ALLOWED_ORIGINS
```

#### Option 3: Local Development (.dev.vars file)

Create a `.dev.vars` file in your project root for local development:

```bash
# Create .dev.vars file (automatically ignored by git)
cat > .dev.vars << EOF
GROQ_API_KEY=your_groq_api_key_here
ALLOWED_ORIGINS=https://yourdomain.com,http://localhost:3000
EOF
```

**Important**: Never commit `.dev.vars` to git (it's automatically ignored).

### 6. Final Deployment

After setting up resources and environment variables, deploy the updated worker:

```bash
# Deploy with updated configuration
wrangler deploy

# Test the deployment
curl https://your-worker-url.workers.dev/api/health
```

### 7. Development and Testing

```bash
# Start local development server
npm run dev

# Test locally
curl http://localhost:8787/api/health
```

## 🚀 Complete Setup Summary

Here's the complete setup flow in order:

```bash
# 1. Setup project
git clone <repository-url>
cd groq-whisper-xl
npm install

# 2. Configure environment files
# Copy and customize the configuration files:
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
cp .env.example .env

# Edit wrangler.toml with your worker name and resource IDs
# Edit .dev.vars with your local development variables
# Edit .env with your production API endpoint

# 3. Login and initial deploy
wrangler login
wrangler deploy

# 4. Create resources
wrangler r2 bucket create groq-whisper-audio
wrangler kv namespace create "GROQ_JOBS_KV"
wrangler kv namespace list  # Note the IDs and update wrangler.toml

# 5. Create queues
wrangler queues create groq-processing-queue
wrangler queues create groq-processing-dlq

# 6. Set environment variables
wrangler secret put GROQ_API_KEY
wrangler secret put ALLOWED_ORIGINS

# 6. Final deployment
wrangler deploy

# 7. Test
curl https://your-worker-url.workers.dev/api/health
```

## 🚀 How to Use

### Choose Your Upload Method

The API supports three different upload methods depending on your needs:

| Method | Best For | Complexity |
|--------|----------|------------|
| **Direct Upload** | Web forms, mobile apps, simple integrations | ⭐ Simple |
| **URL Upload** | Processing audio from web URLs, podcasts | ⭐ Simple |
| **Presigned Upload** | Large files, custom upload logic, progress control | ⭐⭐ Advanced |

---

## 📤 Method 1: Direct Upload (Recommended)

**Single-step upload with FormData - perfect for web forms and mobile apps:**

### FormData Upload
```bash
# Upload file directly with FormData
curl -X POST http://localhost:8787/upload \
  -F "file=@audio.mp3" \
  -F "use_llm=true" \
  -F "webhook_url=https://yoursite.com/webhook"
```

**Response:**
```json
{
  "message": "File uploaded and processing started",
  "job_id": "4b1a372f-d1d7-4ff3-9d02-148ae4a775d9",
  "filename": "audio.mp3",
  "file_size": 15728640,
  "processing_method": "direct",
  "status_url": "/status?job_id=4b1a372f-d1d7-4ff3-9d02-148ae4a775d9",
  "result_url": "/result?job_id=4b1a372f-d1d7-4ff3-9d02-148ae4a775d9"
}
```

### JSON Upload (with base64 data)
```bash
# Upload with JSON + base64 encoded file data
curl -X POST http://localhost:8787/upload \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "audio.mp3",
    "file_data": "base64encodedaudiodata...",
    "use_llm": true,
    "webhook_url": "https://yoursite.com/webhook"
  }'
```

**Parameters:**
- `file` (FormData) or `file_data` (JSON): Your audio file or base64 encoded data
- `use_llm` (optional): Enable AI transcript improvement (recommended for large files)
- `webhook_url` (optional): Get notified when processing completes

---

## 🌐 Method 2: URL Upload

**Download and process audio directly from any URL:**

```bash
# Process audio from a URL
curl -X POST http://localhost:8787/upload-url \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/podcast.mp3",
    "filename": "podcast.mp3",
    "use_llm": true,
    "webhook_url": "https://yoursite.com/webhook"
  }'
```

**Parameters:**
- `url` (required): Direct URL to the audio file
- `filename` (optional): Custom filename (auto-extracted from URL if not provided)
- `use_llm` (optional): Enable AI transcript improvement
- `webhook_url` (optional): Get notified when processing completes

**Response:**
```json
{
  "message": "File downloaded from URL and processing started",
  "job_id": "9385a28f-ccf8-4287-8949-72d2cbc9139c",
  "filename": "podcast.mp3",
  "source_url": "https://example.com/podcast.mp3",
  "file_size": 236781568,
  "processing_method": "chunked",
  "status_url": "/status?job_id=9385a28f-ccf8-4287-8949-72d2cbc9139c",
  "result_url": "/result?job_id=9385a28f-ccf8-4287-8949-72d2cbc9139c"
}
```

**Supported URLs:**
- Direct audio file links (MP3, WAV, FLAC, etc.)
- Video URLs (audio track will be extracted)
- Public URLs (authentication not currently supported)
- Size limit: 1GB per file

---

## 🔧 Method 3: Presigned Upload (Advanced)

**Two-step process for large files and custom upload logic:**

### Complete Transcription Workflow

**Advanced 4-step process for any file size:**

#### Step 1: Get Upload URL
```bash
curl -X POST http://localhost:8787/get-presigned-url \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "my-audio.mp3",
    "use_llm": true
  }'
```

**Parameters:**
- `filename` (required): Your audio file name
- `use_llm` (optional): Enable AI transcript improvement (recommended for large files)
- `webhook_url` (optional): Get notified when processing completes

**Response:**
```json
{
  "job_id": "4b1a372f-d1d7-4ff3-9d02-148ae4a775d9",
  "upload_url": "https://groq-whisper-audio.r2.cloudflarestorage.com/...",
  "instructions": {
    "step1": "Upload your file using: curl -X PUT '<upload_url>' --data-binary @your-file.mp3",
    "step2": "Then call: curl -X POST /start -d '{\"job_id\": \"abc123\"}'",
    "step3": "Check status: curl '/status?job_id=abc123'",
    "step4": "Get result: curl '/result?job_id=abc123'"
  }
}
```

#### Step 2: Upload Your File
```bash
# Use the exact upload_url from step 1
curl -X PUT "https://groq-whisper-audio.r2.cloudflarestorage.com/..." \
  --data-binary @my-audio.mp3
```

#### Step 3: Start Processing
```bash
# Use the job_id from step 1
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{"job_id": "4b1a372f-d1d7-4ff3-9d02-148ae4a775d9"}'
```

**Response:**
```json
{
  "message": "File uploaded successfully, processing started",
  "job_id": "4b1a372f-d1d7-4ff3-9d02-148ae4a775d9",
  "file_size": 15728640,
  "processing_method": "direct"
}
```

#### Step 4: Check Status & Get Results
```bash
# Check processing status
curl "http://localhost:8787/status?job_id=4b1a372f-d1d7-4ff3-9d02-148ae4a775d9"

# Response while processing:
# {"status": "processing", "progress": 67, "error": null}

# Response when complete:
# {"status": "done", "progress": 100, "error": null}
```

```bash
# Get final transcript (when status is "done")
curl "http://localhost:8787/result?job_id=4b1a372f-d1d7-4ff3-9d02-148ae4a775d9"
```

**Final Result:**
```json
{
  "partials": [
    {
      "text": "Hello, this is my audio recording...",
      "segments": [
        {
          "id": 0,
          "start": 0.0,
          "end": 4.5,
          "text": "Hello, this is my audio recording...",
          "avg_logprob": -0.15
        }
      ],
      "start": 0,
      "duration": 15728640,
      "chunk_index": 0
    }
  ],
  "final": "Hello, this is my audio recording with improved punctuation and formatting."
}
```

### 🎯 Processing Types

The system automatically chooses the best processing method based on your file size:

| File Size | Method | Description |
|-----------|--------|-------------|
| ≤ 15MB | **Direct** | Processed immediately as single file |
| > 15MB | **Chunked** | Split into 20MB chunks with 5% overlap for seamless results |

### 💡 Pro Tips

- **Enable LLM correction** (`"use_llm": true`) for better transcript quality on large files
- **Monitor progress** using the `/status` endpoint for large files
- **Set up webhooks** to get notified when processing completes
- **Save your job_id** - you can retrieve results anytime while the job exists (24 hours)

## 🗂️ Job Management

### List All Jobs
```bash
# List all jobs (default: 50 most recent)
curl "http://localhost:8787/jobs"

# Limit results
curl "http://localhost:8787/jobs?limit=20"

# Filter by status
curl "http://localhost:8787/jobs?status=processing"
curl "http://localhost:8787/jobs?status=done"
curl "http://localhost:8787/jobs?status=failed"
```

**Response:**
```json
{
  "jobs": [
    {
      "job_id": "4b1a372f-d1d7-4ff3-9d02-148ae4a775d9",
      "filename": "my-audio.mp3",
      "status": "done",
      "progress": 100,
      "file_size": 15728640,
      "processing_method": "direct",
      "created_at": "2024-01-15T10:30:00Z",
      "uploaded_at": "2024-01-15T10:30:15Z",
      "processing_started_at": "2024-01-15T10:30:20Z",
      "completed_at": "2024-01-15T10:31:45Z",
      "error": null,
      "use_llm": true,
      "expires_at": "2024-01-16T10:30:00Z"
    }
  ],
  "total": 15,
  "showing": 15,
  "filters": null
}
```

### Delete a Job
```bash
# Delete a job and its files
curl -X POST http://localhost:8787/delete-job \
  -H "Content-Type: application/json" \
  -d '{"job_id": "4b1a372f-d1d7-4ff3-9d02-148ae4a775d9"}'
```

**Response:**
```json
{
  "message": "Job deleted successfully",
  "job_id": "4b1a372f-d1d7-4ff3-9d02-148ae4a775d9",
  "deleted_file": "uploads/4b1a372f-d1d7-4ff3-9d02-148ae4a775d9/my-audio.mp3",
  "filename": "my-audio.mp3"
}
```

### Job Lifecycle & File Management

**Automatic Cleanup:**
- ⏰ **Jobs expire after 24 hours** - Both KV data and uploaded files are automatically cleaned up
- 🗑️ **Manual deletion** - Use `/delete-job` to immediately remove jobs and files
- 💾 **R2 Storage** - Files are stored in R2 bucket and deleted when jobs are removed

**Job Status Values:**
- `awaiting_upload` - Presigned URL created, waiting for file upload
- `uploaded` - File uploaded, ready for processing
- `processing` - Currently being transcribed
- `done` - Processing completed successfully
- `failed` - Processing failed (check error field)

## 📋 API Reference

### Available Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| **Direct Upload** |
| `/upload` | POST | Direct file upload (FormData or JSON) |
| `/upload-url` | POST | Download and process audio from URL |
| **Presigned Upload** |
| `/get-presigned-url` | POST | Get presigned URL for file upload |
| `/start` | POST | Trigger processing after upload |
| **Status & Management** |
| `/status?job_id=<id>` | GET | Check job processing status |
| `/result?job_id=<id>` | GET | Get final transcript results |
| `/jobs` | GET | List all jobs with status (without full results) |
| `/delete-job` | POST | Delete a job and its associated files |
| `/process` | POST | Manual processing trigger (dev only) |

## 🖥️ Web Interface

**Note:** Web interface is not implemented in the current version. Use the API endpoints directly for transcription.

## 🏗️ Architecture

### Core Components

1. **Main Router** (`src/index.js`)
   - Single-file implementation with all functionality
   - Upload handling (simple and multipart)
   - Job management and processing
   - Intelligent file processing with automatic chunking

2. **Upload Handlers**
   - **Simple Upload**: Two-step process (presigned URL + trigger)
   - **Multipart Upload**: Advanced chunking for very large files
   - **File Verification**: Automatic size detection and validation

3. **Processing Engine**
   - **Intelligent Processing**: Automatic strategy selection based on file size
   - **Direct Processing**: Small files (≤15MB) processed immediately
   - **Chunked Processing**: Large files split into 20MB chunks with 5% overlap
   - **LLM Correction**: Optional transcript improvement using Llama 3.1 8B

4. **Job Management**
   - **KV Storage**: Job status, progress, and metadata tracking
   - **Queue Processing**: Background job processing with Cloudflare Queues
   - **Webhook Support**: Optional completion notifications

## 📊 Processing Flow

### Simple Upload Flow (Recommended)
```
1. POST /get-presigned-url → Get presigned URL and job ID
2. PUT <upload_url> → Upload file directly to R2
3. POST /start → Trigger intelligent processing
4. GET /status → Monitor progress
5. GET /result → Retrieve transcript when complete
```

### Automatic Processing Strategy
```
File Upload → Size Detection → Processing Method Selection

Small Files (≤ 15MB):
Direct Processing → Immediate Results

Large Files (> 15MB):
Intelligent Chunking (20MB chunks with 5% overlap) → 
Sequential Processing → LLM Correction (if enabled) → 
Merged Results
```



## 💰 Cost Examples

| File Size | Duration | Model | Processing | Total Cost |
|-----------|----------|-------|------------|------------|
| 10MB | 30 min | Turbo | Standard | $0.02 |
| 50MB | 2 hours | Turbo | Advanced | $0.08 |
| 1GB | 20 hours | Turbo | Enterprise | $0.81* |
| 100GB | 1000 hours | Turbo | Enterprise | $40.10* |

*Includes LLM correction (~$1 per 100GB file)

## 🔧 Configuration

### Environment Variables

#### Required Variables
```bash
GROQ_API_KEY=your_groq_api_key    # Get from https://console.groq.com/keys
```

#### Optional Variables
```bash
ALLOWED_ORIGINS=https://yourdomain.com,http://localhost:3000
MAX_FILE_SIZE=107374182400        # 100GB default
ENABLE_DEBUG=false
```

#### Setting Variables by Method

**Via Cloudflare Dashboard:**
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Workers & Pages → Your Worker → Settings → Variables
3. Add each variable and encrypt sensitive ones

**Via Wrangler CLI:**
```bash
# Interactive mode
wrangler secret put GROQ_API_KEY

# Non-interactive mode
echo "your_api_key" | wrangler secret put GROQ_API_KEY

# List current secrets
wrangler secret list
```

**Via .dev.vars (Local Development):**
```bash
# Create file
echo "GROQ_API_KEY=your_key_here" > .dev.vars
echo "ALLOWED_ORIGINS=http://localhost:3000" >> .dev.vars
```

#### Environment Variable Troubleshooting

**Common Issues:**

1. **Variables not available in worker:**
   ```bash
   # Check if variables are set
   wrangler secret list
   
   # Re-deploy after setting variables
   wrangler deploy
   ```

2. **Local development not using .dev.vars:**
   ```bash
   # Ensure .dev.vars is in project root
   ls -la .dev.vars
   
   # Restart dev server
   npm run dev
   ```

3. **Production vs Development variables:**
   ```bash
   # Set for specific environment
   wrangler secret put GROQ_API_KEY --env production
   wrangler secret put GROQ_API_KEY --env development
   ```

### Supported Audio Formats

- **Audio**: MP3, WAV, FLAC, M4A, OGG, AAC, WMA
- **Video**: MP4, MPEG, WEBM (audio track extracted)

## 🛡️ Reliability Features

### Automatic Retries
- **Exponential backoff**: 2s, 5s, 12.5s, 31.25s delays
- **Smart retry logic**: Only retries transient errors
- **Jitter**: Prevents thundering herd effects

### Circuit Breaker
- **Failure threshold**: Opens after 3 consecutive failures
- **Recovery timeout**: 30-second recovery window
- **Health monitoring**: Real-time failure rate tracking

### Error Handling
```json
{
  "error": "Processing failed",
  "message": "Service temporarily unavailable",
  "details": {
    "retries": { "attempted": 4, "message": "All attempts exhausted" },
    "circuit_breaker": { "state": "OPEN" }
  }
}
```

## 🚀 Performance Tips

1. **Model Selection**:
   - English-only: Use `distil-whisper-large-v3-en`
   - Multilingual: Use `whisper-large-v3-turbo`
   - Highest accuracy: Use `whisper-large-v3`

2. **File Optimization**:
   ```bash
   # Optimize audio with FFmpeg
   ffmpeg -i input.wav -ar 16000 -ac 1 -c:a flac output.flac
   ```

3. **Large Files**:
   - Enable LLM correction for better accuracy
   - Monitor job progress via API
   - Consider preprocessing for very large files

## 🔍 Monitoring

```bash
# View logs
npm run tail

# Monitor performance
wrangler analytics

# Check job status
curl "http://localhost:8787/status?job_id=<job_id>"
```

## 📝 Examples & Output

### Direct Upload Examples (Recommended)

#### Example 1: FormData Upload
```bash
# Simple FormData upload
curl -X POST http://localhost:8787/upload \
  -F "file=@example.wav" \
  -F "use_llm=false"
```

**Response:**
```json
{
  "message": "File uploaded and processing started",
  "job_id": "a4e253a3-6132-4c14-8b0b-5ecd7159ac6d",
  "filename": "example.wav",
  "file_size": 4500,
  "processing_method": "direct",
  "status_url": "/status?job_id=a4e253a3-6132-4c14-8b0b-5ecd7159ac6d",
  "result_url": "/result?job_id=a4e253a3-6132-4c14-8b0b-5ecd7159ac6d"
}
```

#### Example 2: URL Upload
```bash
# Download and process from URL
curl -X POST http://localhost:8787/upload-url \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/podcast.mp3",
    "use_llm": true
  }'
```

**Response:**
```json
{
  "message": "File downloaded from URL and processing started",
  "job_id": "b5f372a8-7d42-4c89-9e15-248bf4a885e2",
  "filename": "podcast.mp3",
  "source_url": "https://example.com/podcast.mp3",
  "file_size": 45230000,
  "processing_method": "chunked",
  "status_url": "/status?job_id=b5f372a8-7d42-4c89-9e15-248bf4a885e2",
  "result_url": "/result?job_id=b5f372a8-7d42-4c89-9e15-248bf4a885e2"
}
```

### Presigned Upload Workflow (Advanced)

The presigned upload system works with any file size and automatically handles chunking:

#### Complete Working Example
```bash
# Step 1: Get presigned URL (no file size needed!)
curl -X POST http://localhost:8787/get-presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename": "example.wav", "use_llm": false}'

# Step 2: Upload file (copy upload_url from step 1)
curl -X PUT "https://presigned-url..." --data-binary @example.wav

# Step 3: Start processing (copy job_id from step 1)
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{"job_id": "a4e253a3-6132-4c14-8b0b-5ecd7159ac6d"}'

# Step 4: Check status
curl "http://localhost:8787/status?job_id=a4e253a3-6132-4c14-8b0b-5ecd7159ac6d"

# Step 5: Get results
curl "http://localhost:8787/result?job_id=a4e253a3-6132-4c14-8b0b-5ecd7159ac6d"
```

#### Example 1: Large File Upload (225MB)
```bash
# Step 1: Get presigned upload URL
curl -X POST http://localhost:8787/get-presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename": "large-file.mp3", "use_llm": true}'
```

**Response:**
```json
{
  "job_id": "9385a28f-ccf8-4287-8949-72d2cbc9139c",
  "upload_url": "https://presigned-url...",
  "instructions": {
    "step1": "Upload your file using: curl -X PUT '<upload_url>' --data-binary @your-file.mp3",
    "step2": "Then call: curl -X POST /start -d '{\"job_id\": \"job_id\"}'",
    "step3": "Check status: curl '/status?job_id=job_id'",
    "step4": "Get result: curl '/result?job_id=job_id'"
  }
}
```

```bash
# Step 2: Upload the file directly (copy the upload_url from step 1 response)
curl -X PUT "https://groq-whisper-audio.cceae190abc777c64fb8d7a98be577a3.r2.cloudflarestorage.com/uploads/9385a28f-ccf8-4287-8949-72d2cbc9139c/large-file.mp3?X-Amz-Algorithm=..." \
  --data-binary @large-file.mp3

# Step 3: Trigger intelligent processing (use job_id from step 1)
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{"job_id": "9385a28f-ccf8-4287-8949-72d2cbc9139c"}'
```

**Processing Response:**
```json
{
  "message": "File uploaded successfully, processing started",
  "job_id": "9385a28f-ccf8-4287-8949-72d2cbc9139c",
  "file_size": 236781568,
  "processing_method": "chunked"
}
```

```bash
# Step 4: Monitor progress
curl "http://localhost:8787/status?job_id=9385a28f-ccf8-4287-8949-72d2cbc9139c"
```

**Status Response:**
```json
{
  "status": "processing",
  "progress": 67,
  "error": null
}
```

```bash
# Step 5: Get results when complete
curl "http://localhost:8787/result?job_id=9385a28f-ccf8-4287-8949-72d2cbc9139c"
```

**Final Result:**
```json
{
  "partials": [
    {
      "text": "You're watching TBPN. Today is Friday, July 11th, 2025...",
      "segments": [...],
      "start": 0,
      "duration": 20971520,
      "chunk_index": 0
    }
    // ... 11 more chunks
  ],
  "final": "Here is the cleaned-up transcript:\n\nYou're watching TBPN. Today is Friday, July 11th, 2025. We are live from the TBPN Ultra Dome..."
}
```

### Quick Test with example.wav

The project includes a sample `example.wav` file for testing. Use the Simple Upload API:

```bash
# Step 1: Get presigned URL
curl -X POST http://localhost:8787/get-presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename": "example.wav", "use_llm": false}'

# Step 2: Upload file (use upload_url from step 1)
curl -X PUT "<upload_url_from_step_1>" --data-binary @example.wav

# Step 3: Trigger processing (use job_id from step 1)
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{"job_id": "<job_id_from_step_1>"}'

# Step 4: Check status
curl "http://localhost:8787/status?job_id=<job_id>"

# Step 5: Get results
curl "http://localhost:8787/result?job_id=<job_id>"
```



### Large File Processing

All files use the same Simple Upload API workflow. The system automatically detects file size and applies appropriate processing:

```bash
# Same workflow for all file sizes:

# 1. Get presigned URL
curl -X POST http://localhost:8787/get-presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename": "large-audio.wav", "use_llm": true}'

# 2. Upload file directly (use upload_url from step 1 response)
curl -X PUT "https://presigned-url-from-step-1..." --data-binary @large-audio.wav

# 3. Trigger processing (use job_id from step 1 response)
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{"job_id": "job-id-from-step-1"}'

# 4. Monitor progress (use job_id from step 1 response)
curl "http://localhost:8787/status?job_id=job-id-from-step-1"
```

**Automatic Processing Features:**
- **File size detection**: Automatically chooses direct or chunked processing
- **Intelligent chunking**: 20MB chunks with 5% overlap for seamless transcription
- **LLM correction**: Optional transcript cleaning and improvement (set `use_llm: true`)
- **Progress tracking**: Real-time status updates via `/status` endpoint
- **Error recovery**: Continues processing even if some chunks fail

## 🔧 Quick Reference

### Upload Methods Comparison

```bash
# Method 1: Direct Upload (Simplest)
curl -X POST http://localhost:8787/upload -F "file=@audio.mp3" -F "use_llm=true"

# Method 2: URL Upload (From web)
curl -X POST http://localhost:8787/upload-url -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/audio.mp3", "use_llm": true}'

# Method 3: Presigned Upload (Advanced control)
curl -X POST http://localhost:8787/get-presigned-url -H "Content-Type: application/json" -d '{"filename": "audio.mp3"}'
curl -X PUT "<upload_url>" --data-binary @audio.mp3
curl -X POST http://localhost:8787/start -H "Content-Type: application/json" -d '{"job_id": "<job_id>"}'
```

### Common Job Management Tasks

```bash
# Monitor all jobs
curl "http://localhost:8787/jobs"

# Check specific job status
curl "http://localhost:8787/status?job_id=<job_id>"

# Get results when done
curl "http://localhost:8787/result?job_id=<job_id>"

# Clean up when finished
curl -X POST http://localhost:8787/delete-job -H "Content-Type: application/json" -d '{"job_id": "<job_id>"}'
```

## 🛠️ Development

### Local Testing
```bash
# Start development server
npm run dev

# Method 1: Direct Upload (Easiest)
curl -X POST http://localhost:8787/upload \
  -F "file=@example.wav" \
  -F "use_llm=true"

# Method 2: URL Upload (From web)
curl -X POST http://localhost:8787/upload-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/audio.mp3", "use_llm": true}'

# Method 3: Presigned Upload (Advanced)
# Step 1: Get presigned URL
curl -X POST http://localhost:8787/get-presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename": "example.wav", "use_llm": true}'

# Step 2: Upload file directly (use upload_url from step 1 response)
curl -X PUT "https://presigned-url-from-step-1..." --data-binary @example.wav

# Step 3: Trigger processing
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{"job_id": "job-id-from-step-1"}'

# Check status (for any method)
curl "http://localhost:8787/status?job_id=<job_id>"

# Get results when complete (for any method)
curl "http://localhost:8787/result?job_id=<job_id>"

# Example final result:
# {
#   "partials": [
#     {
#       "text": "Hello, this is a test audio file...",
#       "segments": [...],
#       "start": 0,
#       "duration": 4500,
#       "chunk_index": 0
#     }
#   ],
#   "final": "Hello, this is a test audio file for the Groq Whisper XL transcription service."
# }
```

## 🔐 Security

- CORS protection for specified origins
- File type and size validation
- Automatic cleanup of temporary files
- API key protection
- Rate limiting via Cloudflare

## 📝 License

MIT License - see LICENSE file for details. 
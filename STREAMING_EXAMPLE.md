# 🌊 Groq Whisper XL Streaming API

This document demonstrates the new streaming transcription feature that emulates Groq's chat completion streaming format.

## 🚀 Quick Start

### 1. CLI Method (Recommended)

```bash
# Start the development server
npm run dev

# Run the CLI
node cli.js

# Choose option 4 (Streaming Upload)
```

### 2. Curl Examples

#### Stream with File Upload

```bash
# Basic streaming without LLM
curl -X POST http://localhost:8787/stream \
  -F "file=@example.wav" \
  -F "chunk_size_mb=1" \
  -F "use_llm=false"

# Real-time per-chunk LLM correction (recommended)
curl -X POST http://localhost:8787/stream \
  -F "file=@example.wav" \
  -F "chunk_size_mb=1" \
  -F "use_llm=true" \
  -F "llm_mode=per_chunk"

# Full-context post-processing LLM correction
curl -X POST http://localhost:8787/stream \
  -F "file=@example.wav" \
  -F "chunk_size_mb=1" \
  -F "use_llm=true" \
  -F "llm_mode=post_process"
```

#### Stream with URL

```bash
curl -X POST http://localhost:8787/stream \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/audio.mp3",
    "chunk_size_mb": 0.5,
    "use_llm": true,
    "llm_mode": "per_chunk"
  }'
```

#### Stream with Base64 Data

```bash
curl -X POST http://localhost:8787/stream \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "test.wav",
    "file_data": "UklGRnoBAABXQVZFZm10IBAAAA...",
    "chunk_size_mb": 1,
    "use_llm": false
  }'
```

## 📡 Response Format

The streaming API returns Server-Sent Events (SSE) in this format:

```
data: {"type": "status", "message": "Starting transcription", "filename": "audio.mp3", ...}

data: {"type": "chunk_info", "total_chunks": 5, "chunk_size_mb": 1}

data: {"type": "chunk_start", "chunk_index": 0, "progress": 20}

data: {"type": "delta", "chunk_index": 0, "raw_text": "hello this is first chunk", "corrected_text": "Hello, this is the first chunk.", "llm_applied": true, "segments": [...]}

data: {"type": "chunk_done", "chunk_index": 0, "progress": 20}

...

data: {"type": "done", "final_transcript": "Complete transcription...", "total_segments": 25}
```

## 🎯 Event Types

| Event Type | Description | Example Data |
|------------|-------------|--------------|
| `status` | Initial processing status | `{filename, total_size, estimated_chunks}` |
| `chunk_info` | Chunk processing details | `{total_chunks, chunk_size_mb}` |
| `chunk_start` | Starting to process a chunk | `{chunk_index, progress}` |
| `delta` | **Incremental transcript text** | `{raw_text, corrected_text?, llm_applied, segments, chunk_index}` |
| `chunk_done` | Chunk processing completed | `{chunk_index, progress}` |
| `chunk_error` | Chunk processing failed | `{chunk_index, error}` |
| `llm_processing` | LLM correction starting | `{message}` |
| `llm_done` | LLM correction completed | `{corrected_text}` |
| `llm_error` | LLM correction failed | `{error, fallback_text}` |
| `done` | **Final completion** | `{final_transcript, total_segments}` |
| `error` | Stream error | `{error}` |

## 💡 Key Features

### ⚡ Real-time Streaming
- Uses tiny chunks (0.5-2MB) instead of the standard 20MB
- Returns results as each chunk is processed
- Similar to Groq's chat streaming with `delta` events

### 🧠 LLM Integration (NEW!)
- **Per-chunk correction**: Real-time LLM improvements using Llama 3.1 8B Instant
- **Post-processing**: Full-context correction after all chunks are processed
- Streams both raw and corrected transcripts
- Graceful fallback if LLM correction fails
- Optimized prompts for speed and cost-effectiveness

### 📊 Progress Tracking
- Real-time progress updates
- Chunk-by-chunk processing status
- Error handling for failed chunks

## 🔧 Configuration Options

| Parameter | Description | Default | Range |
|-----------|-------------|---------|-------|
| `chunk_size_mb` | Size of each processing chunk in MB | 0.25 | 0.1 - 5 |
| `use_llm` | Enable LLM transcript correction | false | true/false |
| `llm_mode` | LLM correction mode | per_chunk | per_chunk/post_process |
| `filename` | Custom filename for uploads | auto-detected | any string |

## 🚀 JavaScript Example

```javascript
async function streamTranscription(audioFile) {
  const formData = new FormData();
  formData.append('file', audioFile);
  formData.append('chunk_size_mb', '1');
  formData.append('use_llm', 'true');

  const response = await fetch('/stream', {
    method: 'POST',
    body: formData
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        
                 switch (data.type) {
           case 'delta':
             if (data.llm_applied) {
               console.log('📝 Raw:', data.raw_text);
               console.log('🧠 LLM:', data.corrected_text);
             } else {
               console.log('📝 Text:', data.raw_text || data.text);
             }
             break;
           case 'done':
             console.log('✅ Final transcript:', data.final_transcript);
             break;
           case 'error':
             console.error('❌ Error:', data.error);
             break;
         }
      }
    }
  }
}
```

## 🎵 Testing with Sample Audio

If you have a sample audio file, test streaming with different chunk sizes:

```bash
# Ultra-fast streaming (default)
curl -X POST http://localhost:8787/stream -F "file=@sample.wav" -F "chunk_size_mb=0.25"

# Fast streaming  
curl -X POST http://localhost:8787/stream -F "file=@sample.wav" -F "chunk_size_mb=0.5"

# Balanced streaming
curl -X POST http://localhost:8787/stream -F "file=@sample.wav" -F "chunk_size_mb=1"

# Slower streaming (larger chunks)
curl -X POST http://localhost:8787/stream -F "file=@sample.wav" -F "chunk_size_mb=2"
```

## 🔍 Debugging

### Check Server Status
```bash
curl http://localhost:8787/health
```

### Verbose Curl Output
```bash
curl -v -X POST http://localhost:8787/stream \
  -F "file=@sample.wav" \
  -F "chunk_size_mb=1"
```

### Monitor Processing
The CLI tool (option 4) provides the best debugging experience with real-time progress indicators and error handling.

## 📈 Performance Notes

- **Smaller chunks (0.25-0.5MB)**: Fastest streaming, more API calls, near real-time
- **Medium chunks (1-2MB)**: Balanced streaming, moderate API calls
- **Larger chunks (2-5MB)**: Slower streaming, fewer API calls  
- **LLM correction**: Adds processing time but improves quality
- **Network latency**: Affects streaming responsiveness

### 🎯 Recommended Settings:
- **Real-time demo**: 0.25MB chunks, no LLM
- **Production streaming**: 0.5-1MB chunks, per-chunk LLM  
- **Batch processing**: Use regular `/upload` endpoint instead

## 🆚 Comparison with Standard API

| Feature | Standard API | Streaming API |
|---------|-------------|---------------|
| **Response Time** | Wait for completion | Real-time chunks |
| **Chunk Size** | 20MB | 0.5-5MB (configurable) |
| **Progress Updates** | Polling required | Built-in streaming |
| **Use Case** | Production batch processing | Development, testing, real-time UX |
| **Resource Usage** | Lower (fewer API calls) | Higher (more API calls) |

The streaming API is perfect for:
- 🧪 Testing and development
- 🎮 Interactive applications  
- 📱 Real-time user interfaces
- 🔍 Quick previews of transcription quality 
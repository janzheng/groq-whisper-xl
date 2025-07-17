# Unified Logging System

This document describes the standardized logging system implemented across all components of the Groq Whisper XL project.

## Overview

The unified logging system provides consistent, emoji-based logging across:
- **API/Server** (`src/index.js`) - Cloudflare Worker backend
- **CLI** (`cli.js`) - Command-line interface
- **Web Interface** (`src/static-web.js`) - Browser-based UI

## Features

### ✨ Consistent Formatting
- **Emoji categorization** for quick visual scanning
- **Structured data logging** with JSON context
- **Context-aware prefixes** (`[API]`, `[CLI]`, `[WEB]`, `[STREAM]`, etc.)
- **Timestamp inclusion** for debugging

### 🎯 Log Levels
- `DEBUG` (0) - Detailed debugging information
- `INFO` (1) - General information and operation status
- `WARN` (2) - Warning conditions
- `ERROR` (3) - Error conditions

### 📊 Categorized Operations
Each operation type has a dedicated emoji and logging method:

| Category | Emoji | Method | Usage |
|----------|-------|--------|-------|
| Process States | 🚀 🔄 ✅ ❌ | `start()`, `processing()`, `complete()`, `failed()` | Process lifecycle |
| File Operations | 📤 📥 📁 🗑️ | `upload()`, `download()`, `file()`, `delete()` | File handling |
| Audio/Transcription | 🎵 🎤 🧩 🌊 🧠 | `audio()`, `transcribe()`, `chunk()`, `stream()`, `llm()` | Audio processing |
| Network/API | 📡 🔗 🌐 | `api()`, `webhook()`, `url()` | Network operations |
| Information | ℹ️ ⚠️ ❌ 🔍 📊 | `info()`, `warn()`, `error()`, `debug()`, `stats()` | General logging |

## Implementation

### API/Server Logger (Cloudflare Worker)
```javascript
// Create loggers for different contexts
const apiLogger = new UnifiedLogger('API', UnifiedLogger.levels.INFO);
const processingLogger = new UnifiedLogger('PROCESSING', UnifiedLogger.levels.INFO);
const streamLogger = new UnifiedLogger('STREAM', UnifiedLogger.levels.INFO);

// Usage examples
apiLogger.upload('File uploaded successfully', { 
  filename: 'audio.mp3', 
  size: '2.5MB',
  job_id: 'abc123' 
});

processingLogger.chunk('Processing chunk 3/10', {
  chunk_index: 3,
  progress: 30,
  job_id: 'abc123'
});

streamLogger.complete('Streaming transcription completed', {
  chunks_processed: 25,
  total_time: '45s'
});
```

### CLI Logger (Node.js)
```javascript
// CLI logger with colored output
const cliLogger = new UnifiedLogger('CLI', UnifiedLogger.levels.INFO);

// Usage examples
cliLogger.stream('Processing streaming response...', {
  filename: 'podcast.mp3',
  chunk_size: '1MB'
});

cliLogger.complete('Transcript saved', { 
  filename: 'output.txt',
  length: 1205 
});

cliLogger.error('Failed to save transcript file', error);
```

### Web Logger (Browser)
```javascript
// Browser-compatible loggers
const webLogger = new UnifiedLogger('WEB', UnifiedLogger.levels.INFO);
const streamLogger = new UnifiedLogger('STREAM', UnifiedLogger.levels.INFO);

// Usage examples
webLogger.stats('Jobs update', { 
  total: 15, 
  running: 3, 
  completed: 12 
});

streamLogger.complete('Stream reader reached end');
```

## Output Examples

### API Logs
```
🚀 [API] File uploaded successfully | {"filename":"audio.mp3","size":"2.5MB","job_id":"abc123"}
🔄 [PROCESSING] Processing chunk 3/10 | {"chunk_index":3,"progress":30,"job_id":"abc123"}
✅ [STREAM] Streaming transcription completed | {"chunks_processed":25,"total_time":"45s"}
❌ [API] LLM correction failed | {"message":"Rate limit exceeded","original_length":1205}
```

### CLI Logs (with colors)
```
🌊 [CLI] Processing streaming response... {"filename":"podcast.mp3","chunk_size":"1MB"}
✅ [CLI] Transcript saved {"filename":"output.txt","length":1205}
❌ [CLI] Failed to save transcript file {"message":"Permission denied"}
```

### Web Logs (browser console)
```
📊 [WEB] Jobs update {"total":15,"running":3,"completed":12}
🌊 [STREAM] Stream reader reached end
⚠️ [WEB] Failed to parse stream data {"error":"Invalid JSON"}
```

## Benefits

### 🔍 **Debugging**
- **Consistent format** makes logs easy to scan
- **Structured data** enables better filtering and analysis
- **Context prefixes** clearly identify which component generated the log

### 📈 **Monitoring**
- **Categorized operations** enable metric collection
- **Structured data** supports log aggregation systems
- **Standardized format** works with log parsing tools

### 🛠 **Development**
- **Visual emoji scanning** for quick issue identification
- **Consistent API** across all environments
- **Rich context data** for troubleshooting

### 🎯 **Production**
- **Configurable log levels** for performance tuning
- **Structured JSON** for log analysis systems
- **Error context preservation** for better debugging

## Configuration

### Log Levels
```javascript
// Set different log levels per environment
const logger = new UnifiedLogger('API', 
  process.env.NODE_ENV === 'development' 
    ? UnifiedLogger.levels.DEBUG 
    : UnifiedLogger.levels.INFO
);
```

### Context Identification
```javascript
// Different contexts for different subsystems
const uploadLogger = new UnifiedLogger('UPLOAD');
const streamLogger = new UnifiedLogger('STREAM');
const webhookLogger = new UnifiedLogger('WEBHOOK');
```

## Migration

The unified logging system replaces scattered `console.log` statements with:

### Before
```javascript
console.log(`🎵 Processing ${job.filename} (${formatBytes(fileSize)})`);
console.error('❌ Processing failed:', error);
```

### After
```javascript
processingLogger.processing('Starting processing', {
  filename: job.filename,
  size: formatBytes(fileSize),
  job_id: job_id
});
processingLogger.error('Processing failed', error, { job_id, filename: job.filename });
```

## Future Enhancements

- **Log aggregation** integration with external services
- **Performance metrics** collection
- **Real-time log streaming** to web interface
- **Configurable output formats** (JSON, plain text, etc.)
- **Log filtering** by category or context
- **Automated error alerting** based on log patterns 
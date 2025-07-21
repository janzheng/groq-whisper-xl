# Chunked Upload Streaming

This module provides functionality for uploading large audio files in chunks with real-time streaming transcription feedback. It combines the benefits of multi-part uploads, immediate processing, and real-time progress updates.

## Features

- **Large File Support**: Handle files up to 10GB efficiently
- **Real-time Feedback**: See transcription results as chunks complete
- **Parallel Processing**: Upload and process multiple chunks simultaneously
- **Fault Tolerance**: Individual chunk failures don't break the entire job
- **Resume Capability**: Retry failed chunks without affecting others
- **LLM Correction**: Optional AI-powered transcript improvement
- **Automatic Cleanup**: Temporary files are cleaned up automatically

## Architecture

```
ParentJob (coordinates overall process)
├── SubJob-0 (chunk 0: 0-10MB) → Upload → Process → Stream Result
├── SubJob-1 (chunk 1: 10-20MB) → Upload → Process → Stream Result  
├── SubJob-2 (chunk 2: 20-30MB) → Upload → Process → Stream Result
└── ... → Final Assembly → Complete
```

## API Endpoints

### 1. Initialize Chunked Upload Session

**POST** `/chunked-upload-stream`

```bash
curl -X POST http://localhost:8787/chunked-upload-stream \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "large-podcast.mp3",
    "total_size": 524288000,
    "chunk_size_mb": 5,
    "use_llm": true,
    "llm_mode": "per_chunk",
    "webhook_url": "https://example.com/webhook"
  }'
```

**Response:**
```json
{
  "message": "Chunked upload streaming initialized successfully",
  "parent_job_id": "uuid-here",
  "stream_url": "/chunked-stream/uuid-here",
  "upload_urls": [
    {
      "chunk_index": 0,
      "upload_url": "signed-url-1",
      "expected_size": 10485760,
      "byte_range": [0, 10485759]
    },
    {
      "chunk_index": 1,
      "upload_url": "signed-url-2", 
      "expected_size": 10485760,
      "byte_range": [10485760, 20971519]
    }
  ],
  "chunk_info": {
    "total_chunks": 50,
    "chunk_size_bytes": 10485760,
    "estimated_processing_time": "15-20 minutes"
  }
}
```

### 2. Monitor Progress via SSE Stream

**GET** `/chunked-stream/{parent_job_id}`

```bash
curl -N http://localhost:8787/chunked-stream/uuid-here
```

**SSE Events:**
```
data: {"type": "initialized", "parent_job_id": "uuid", "total_chunks": 50}

data: {"type": "progress_update", "progress": 25, "uploaded_chunks": 10, "completed_chunks": 5}

data: {"type": "chunk_complete", "chunk_index": 0, "text": "Hello world transcript"}

data: {"type": "partial_transcript", "partial_transcript": "Combined text so far..."}

data: {"type": "final_result", "final_transcript": "Complete transcript", "status": "completed"}
```

### 3. Upload Chunks

Use the presigned URLs from step 1:

```bash
# Upload chunk 0
curl -X PUT "signed-url-1" --data-binary @chunk0.mp3

# Upload chunk 1  
curl -X PUT "signed-url-2" --data-binary @chunk1.mp3

# Can upload multiple chunks in parallel
```

### 4. Notify Upload Completion

**POST** `/chunk-upload-complete`

```bash
curl -X POST http://localhost:8787/chunk-upload-complete \
  -H "Content-Type: application/json" \
  -d '{
    "parent_job_id": "uuid-here",
    "chunk_index": 0,
    "actual_size": 10485760
  }'
```

### 5. Get Status

**GET** `/chunked-upload-status?parent_job_id=uuid`

```bash
curl http://localhost:8787/chunked-upload-status?parent_job_id=uuid-here
```

### 6. Cancel Upload

**POST** `/chunked-upload-cancel`

```bash
curl -X POST http://localhost:8787/chunked-upload-cancel \
  -H "Content-Type: application/json" \
  -d '{
    "parent_job_id": "uuid-here",
    "reason": "user_cancelled"
  }'
```

## Implementation Example

### JavaScript Client

```javascript
class ChunkedUploadClient {
  async uploadLargeFile(file, options = {}) {
    const {
      chunkSizeMB = 5,
      useLLM = false,
      llmMode = 'per_chunk',
      maxConcurrentUploads = 3
    } = options;

    // 1. Initialize session
    const initResponse = await fetch('/chunked-upload-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        total_size: file.size,
        chunk_size_mb: chunkSizeMB,
        use_llm: useLLM,
        llm_mode: llmMode
      })
    });
    
    const { parent_job_id, upload_urls, stream_url } = await initResponse.json();

    // 2. Open SSE stream for real-time updates
    const eventSource = new EventSource(stream_url);
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleStreamEvent(data);
    };

    // 3. Upload chunks in parallel
    await this.uploadChunksInParallel(file, upload_urls, parent_job_id, maxConcurrentUploads);
    
    return parent_job_id;
  }

  async uploadChunksInParallel(file, uploadUrls, parentJobId, maxConcurrent) {
    const semaphore = new Semaphore(maxConcurrent);
    
    const uploadPromises = uploadUrls.map(async (urlInfo) => {
      await semaphore.acquire();
      
      try {
        const chunk = file.slice(
          urlInfo.byte_range[0], 
          urlInfo.byte_range[1] + 1
        );
        
        // Upload chunk
        await fetch(urlInfo.upload_url, {
          method: 'PUT',
          body: chunk
        });
        
        // Notify completion
        await fetch('/chunk-upload-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent_job_id: parentJobId,
            chunk_index: urlInfo.chunk_index,
            actual_size: chunk.size
          })
        });
      } finally {
        semaphore.release();
      }
    });
    
    await Promise.all(uploadPromises);
  }

  handleStreamEvent(data) {
    switch (data.type) {
      case 'progress_update':
        this.updateProgress(data.progress, data.uploaded_chunks, data.completed_chunks);
        break;
      case 'chunk_complete':
        this.displayChunkResult(data.chunk_index, data.text);
        break;
      case 'partial_transcript':
        this.updatePartialTranscript(data.partial_transcript);
        break;
      case 'final_result':
        this.displayFinalResult(data.final_transcript);
        break;
    }
  }
}
```

## Configuration

### Size Limits
- **Minimum file size**: 5MB (use regular streaming for smaller files)
- **Maximum file size**: 10GB
- **Chunk size range**: 1MB - 100MB
- **Default chunk size**: 5MB

### Processing Options
- **LLM Modes**: 
  - `per_chunk`: Apply LLM correction to each chunk individually
  - `post_process`: Apply LLM correction to final assembled transcript
- **Max concurrent uploads**: 5 (configurable)
- **Max concurrent processing**: 3 (to respect API rate limits)

### Timeouts
- **Upload URL expiry**: 1 hour
- **SSE stream timeout**: 30 minutes
- **Processing timeout**: 1 hour per job

## Error Handling

### Chunk Upload Failures
```bash
# Retry failed chunk
curl -X POST http://localhost:8787/chunked-upload-retry \
  -H "Content-Type: application/json" \
  -d '{
    "parent_job_id": "uuid-here",
    "chunk_index": 5
  }'
```

### Common Error Scenarios
1. **Network interruption during upload**: Individual chunks can be retried
2. **Processing failures**: Failed chunks don't affect successful ones
3. **Timeout issues**: SSE stream can be reconnected, job continues processing
4. **Storage issues**: Automatic cleanup handles partial uploads

## Monitoring & Observability

### Job Status Tracking
- **Upload progress**: Percentage of chunks uploaded
- **Processing progress**: Percentage of chunks processed
- **Success rate**: Ratio of successful to total chunks
- **Time estimates**: Based on current processing speed

### Logging
All operations are logged with structured data including:
- Job IDs and chunk indices
- Processing times and sizes
- Error details and retry attempts
- Performance metrics

## Integration with Existing System

The chunked upload streaming integrates seamlessly with the existing job management system:

- Shows up in `/jobs` listing with enhanced metadata
- Compatible with existing webhook system
- Uses same authentication and rate limiting
- Shares logging and monitoring infrastructure

## Best Practices

### Client Implementation
1. **Parallel uploads**: Upload multiple chunks simultaneously (max 3-5)
2. **Progress tracking**: Use SSE stream for real-time updates
3. **Error recovery**: Implement retry logic for failed chunks
4. **User feedback**: Show detailed progress with chunk status

### Performance Optimization
1. **Chunk size**: 5-20MB chunks provide good balance
2. **Concurrency**: Limit concurrent uploads to avoid overwhelming
3. **Network awareness**: Adjust chunk size based on connection speed
4. **Resume capability**: Store upload progress for resume functionality

### Production Considerations
1. **Monitor queue depth**: Ensure processing keeps up with uploads
2. **Storage cleanup**: Failed uploads are automatically cleaned up
3. **Resource limits**: Chunked uploads use more temporary storage
4. **Cost optimization**: Larger chunks reduce API calls but use more memory 
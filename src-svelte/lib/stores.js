import { writable } from 'svelte/store';
import { webLogger } from './logger.js';

// Core application state
export const jobs = writable([]);
export const isUploading = writable(false);
export const isStreaming = writable(false);
export const showStreamingResults = writable(false); // New store for showing results after streaming
export const currentStreamingFilename = writable('');
export const streamStartTime = writable(Date.now());

// Streaming display state stores
export const streamingProgress = writable(0);
export const streamingTranscript = writable('');
export const chunksProcessed = writable(0);
export const totalChunks = writable(0);
export const streamingFileSize = writable('');
export const streamingLLMMode = writable('disabled');

// Chunked streaming state stores
export const isChunkedStreaming = writable(false);
export const showChunkedStreamingResults = writable(false); // New store for showing results after chunked streaming
export const chunkedStreamingMode = writable(false); // toggle between regular and chunked streaming
export const chunkSlots = writable([]); // Array of chunk status objects
export const chunkedViewMode = writable('speed'); // 'speed' (first-to-complete) or 'order' (in-order only)
export const chunkedProgress = writable({ upload: 0, processing: 0, overall: 0 });
export const chunkedReadableTranscript = writable(''); // Only contiguous chunks
export const currentChunkedJobId = writable('');
export const chunkedTotalChunks = writable(0);
export const chunkedUploadedChunks = writable(0);
export const chunkedCompletedChunks = writable(0);
export const chunkedFailedChunks = writable(0);
export const chunkedSuccessRate = writable(0);
export const chunkedFileSize = writable('');

// API base URL
export const API_BASE = '';

// Utility functions
export function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Chunked streaming utility functions
export function initializeChunkSlots(totalChunks) {
  const slots = Array(totalChunks).fill(null).map((_, index) => ({
    chunkIndex: index,
    status: 'pending', // pending | uploading | processing | complete | failed
    text: '',
    rawText: '',
    correctedText: '',
    processingTime: null,
    completedAt: null, // Timestamp when chunk completed
    arrivalOrder: null, // Order in which chunk completed (0, 1, 2...)
    uploadProgress: 0,
    error: null,
    llmApplied: false,
    segments: []
  }));
  chunkSlots.set(slots);
  return slots;
}

// Track global arrival counter
let globalArrivalCounter = 0;

export function updateChunkSlot(chunkIndex, updates) {
  chunkSlots.update(slots => {
    if (slots[chunkIndex]) {
      const updatedChunk = { ...slots[chunkIndex], ...updates };
      
      // If this is marking the chunk as complete, add timestamp and arrival order
      if (updates.status === 'complete' && slots[chunkIndex].status !== 'complete') {
        updatedChunk.completedAt = new Date().toISOString();
        updatedChunk.arrivalOrder = globalArrivalCounter++;
      }
      
      slots[chunkIndex] = updatedChunk;
    }
    return [...slots]; // Return new array to trigger reactivity
  });
}

export function resetChunkedStreaming() {
  isChunkedStreaming.set(false);
  showChunkedStreamingResults.set(false);
  chunkSlots.set([]);
  chunkedReadableTranscript.set('');
  currentChunkedJobId.set('');
  chunkedTotalChunks.set(0);
  chunkedUploadedChunks.set(0);
  chunkedCompletedChunks.set(0);
  chunkedFailedChunks.set(0);
  chunkedSuccessRate.set(0);
  chunkedFileSize.set('');
  chunkedProgress.set({ upload: 0, processing: 0, overall: 0 });
  
  // Reset arrival counter
  globalArrivalCounter = 0;
}

// Note: localStorage functions removed - they were disabled and causing no-op calls 
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

// Note: localStorage functions removed - they were disabled and causing no-op calls 
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

// Save and load streaming jobs from localStorage - DISABLED to fix caching issues
export function saveStreamingJobsToStorage() {
  // No-op: localStorage saving disabled to prevent refresh/caching issues
  // jobs.subscribe(jobList => {
  //   const streamingJobs = jobList.filter(job => job.processing_method === 'streaming');
  //   localStorage.setItem('groq_streaming_jobs', JSON.stringify(streamingJobs));
  //   webLogger.debug('Saved streaming jobs to localStorage', { count: streamingJobs.length });
  // })();
}

export function loadStreamingJobsFromStorage() {
  // No-op: localStorage loading disabled to prevent refresh/caching issues
  // try {
  //   const stored = localStorage.getItem('groq_streaming_jobs');
  //   if (stored) {
  //     const streamingJobs = JSON.parse(stored);
  //     jobs.set([...streamingJobs]);
  //     webLogger.info('stream', 'Loaded streaming jobs from localStorage', { count: streamingJobs.length });
  //   }
  // } catch (error) {
  //   webLogger.warn('Failed to load streaming jobs from localStorage', error);
  // }
} 
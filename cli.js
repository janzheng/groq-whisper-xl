#!/usr/bin/env node

import { readFileSync, existsSync, statSync } from 'fs';
import { createReadStream } from 'fs';
import { basename, extname } from 'path';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { config } from 'dotenv';
import { LoadingIndicator, ProgressBar, AnimatedText } from './src/ui-helpers.js';
import { JobManager } from './src/job-manager.js';

// Load environment variables
config();

// ============================================================================
// UNIFIED LOGGING SYSTEM (CLI VERSION)
// ============================================================================

/**
 * Standardized logging system for consistent output across CLI, Web, and API
 * CLI version includes colored output and terminal-optimized formatting
 */
class UnifiedLogger {
  static levels = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };

  static emojis = {
    // Process states
    start: '🚀',
    processing: '🔄',
    complete: '✅',
    failed: '❌',
    
    // File operations
    upload: '📤',
    download: '📥',
    file: '📁',
    delete: '🗑️',
    
    // Audio/transcription
    audio: '🎵',
    transcribe: '🎤',
    chunk: '🧩',
    stream: '🌊',
    llm: '🧠',
    
    // Network/API
    api: '📡',
    webhook: '🔗',
    url: '🌐',
    
    // Status/info
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌',
    debug: '🔍',
    stats: '📊',
    time: '⏱️',
    progress: '📈'
  };

  static colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
  };

  constructor(context = 'CLI', level = UnifiedLogger.levels.INFO, useColors = true) {
    this.context = context;
    this.level = level;
    this.useColors = useColors;
  }

  _colorize(text, color) {
    if (!this.useColors) return text;
    return `${UnifiedLogger.colors[color] || ''}${text}${UnifiedLogger.colors.reset}`;
  }

  _formatMessage(emoji, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const contextStr = this._colorize(`[${this.context}]`, 'gray');
    const prefix = `${emoji} ${contextStr}`;
    
    if (data && Object.keys(data).length > 0) {
      const dataStr = this._colorize(JSON.stringify(data), 'gray');
      return `${prefix} ${message} ${dataStr}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message, data = null) {
    if (this.level <= UnifiedLogger.levels.DEBUG) {
      const formatted = this._formatMessage(UnifiedLogger.emojis.debug, 
        this._colorize(message, 'gray'), data);
      console.log(formatted);
    }
  }

  info(emoji, message, data = null) {
    if (this.level <= UnifiedLogger.levels.INFO) {
      const emojiSymbol = UnifiedLogger.emojis[emoji] || emoji;
      const coloredMessage = this._colorize(message, 'white');
      const formatted = this._formatMessage(emojiSymbol, coloredMessage, data);
      console.log(formatted);
    }
  }

  warn(message, data = null) {
    if (this.level <= UnifiedLogger.levels.WARN) {
      const coloredMessage = this._colorize(message, 'yellow');
      const formatted = this._formatMessage(UnifiedLogger.emojis.warning, coloredMessage, data);
      console.warn(formatted);
    }
  }

  error(message, error = null, data = null) {
    if (this.level <= UnifiedLogger.levels.ERROR) {
      const errorData = error ? { 
        message: error.message, 
        stack: error.stack?.substring(0, 200),
        ...data 
      } : data;
      const coloredMessage = this._colorize(message, 'red');
      const formatted = this._formatMessage(UnifiedLogger.emojis.error, coloredMessage, errorData);
      console.error(formatted);
    }
  }

  // Convenience methods for common operations
  upload(message, data = null) { this.info('upload', message, data); }
  download(message, data = null) { this.info('download', message, data); }
  processing(message, data = null) { this.info('processing', message, data); }
  complete(message, data = null) { this.info('complete', message, data); }
  chunk(message, data = null) { this.info('chunk', message, data); }
  transcribe(message, data = null) { this.info('transcribe', message, data); }
  llm(message, data = null) { this.info('llm', message, data); }
  api(message, data = null) { this.info('api', message, data); }
  stats(message, data = null) { this.info('stats', message, data); }
  stream(message, data = null) { this.info('stream', message, data); }
}

// Create CLI logger instance
const cliLogger = new UnifiedLogger('CLI', UnifiedLogger.levels.INFO);

// Configuration
const DEFAULT_BASE_URL = process.env.LOCAL_URL || 'http://localhost:8787';
const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://your-worker-name.your-subdomain.workers.dev';



class GroqWhisperCLI {
  constructor() {
    this.baseUrl = DEFAULT_BASE_URL;
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    this.jobManager = new JobManager(this.baseUrl, this);
  }

  async question(prompt) {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  async pingEndpoint() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        return { online: true, status: response.status, message: 'Endpoint is online' };
      } else {
        return { online: false, status: response.status, message: `Endpoint returned ${response.status}` };
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return { online: false, status: 'timeout', message: 'Endpoint timeout (>5s)' };
      } else if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
        return { online: false, status: 'connection_failed', message: 'Connection refused' };
      } else {
        return { online: false, status: 'error', message: error.message };
      }
    }
  }

  async checkConnectivityBeforeOperation() {
    const loader = new LoadingIndicator();
    loader.start('🔍 Checking server availability...', 'pulse', '\x1b[33m');
    
    const pingResult = await this.pingEndpoint();
    loader.stop();
    
    if (!pingResult.online) {
      console.log(`\n⚠️  Warning: Server appears to be offline (${pingResult.message})`);
      const proceed = await this.question('Continue anyway? (y/N): ');
      if (!proceed.toLowerCase().startsWith('y')) {
        console.log('Operation cancelled. Use option 8 to change endpoint or option 10 to test connectivity.');
        return false;
      }
    }
    return true;
  }

  async showWelcome() {
    console.clear();
    
    // Animated welcome
    const title = `
╔══════════════════════════════════════════════════════════════╗
║                    🎤 Groq Whisper XL CLI                    ║
║              Universal Audio Transcription Tool              ║
╚══════════════════════════════════════════════════════════════╝`;

    console.log(AnimatedText.glow(title));
    
    const loader = new LoadingIndicator();
    loader.start('🚀 Initializing system...', 'star', '\x1b[35m');
    await this.sleep(800);
    loader.stop();

    // Check endpoint connectivity
    loader.start('🌐 Checking endpoint connectivity...', 'pulse', '\x1b[36m');
    const pingResult = await this.pingEndpoint();
    loader.stop();

    console.log(`
${AnimatedText.rainbow('✨ Features:')}
• 🚀 Ultra-fast transcription using Groq's Whisper API
• 📁 Universal file support (MB to 100GB+)
• 🎯 Smart tier detection (Standard/Advanced/Enterprise)
• 🤖 LLM error correction for improved accuracy
• 🌐 URL-based audio processing
• 📊 Real-time progress tracking

Current endpoint: ${AnimatedText.glow(this.baseUrl)}`);

    // Show connectivity status
    if (pingResult.online) {
      console.log(`🟢 Status: ${AnimatedText.glow('ONLINE')} - Ready for transcription`);
    } else {
      console.log(`🔴 Status: ${AnimatedText.rainbow('OFFLINE')} - ${pingResult.message}`);
      console.log(`\n⚠️  Warning: The endpoint is not responding. Please check:`);
      console.log(`   • Is your worker running? Try: npm run dev`);
      console.log(`   • Is the endpoint URL correct?`);
      console.log(`   • Are you connected to the internet?`);
      console.log(`   • Try option 8 to change endpoint or option 10 to test connectivity`);
    }
    
    console.log('');
  }

  async showMainMenu() {
    console.log(`
┌─────────────────────────────────────────────────────────────┐
│                        Main Menu                            │
├─────────────────────────────────────────────────────────────┤
│ Upload Methods:                                             │
│   1. 📤 Direct Upload (Recommended)                         │
│   2. 🌐 URL Upload (From web)                               │
│   3. 🔧 Presigned Upload (Advanced)                         │
│   4. 🌊 Streaming Upload (Real-time results)                │
│   5. ⚡ Chunked Upload Streaming (Large files, fastest)     │
│                                                             │
│ Job Management:                                             │
│   6. 📋 List Jobs                                           │
│   7. 📊 Check Job Status                                    │
│   8. 📄 Get Job Results                                     │
│   9. 🗑️  Delete Job                                          │
│                                                             │
│ Settings:                                                   │
│  10. ⚙️  Change Endpoint                                     │
│  11. ❓ Help & Examples                                     │
│  12. 🌐 Test Connectivity                                   │
│   0. 🚪 Exit                                                │
└─────────────────────────────────────────────────────────────┘
`);

    const choice = await this.question('Choose an option (0-12): ');
    return choice.trim();
  }

  async changeEndpoint() {
    console.log(`\n🔧 Change Endpoint\n`);
    console.log(`Current endpoint: ${this.baseUrl}`);
    console.log(`\nOptions:`);
    console.log(`1. Local development (${DEFAULT_BASE_URL})`);
    console.log(`2. Production (${PRODUCTION_URL})`);
    console.log(`3. Custom URL`);

    const choice = await this.question('\nChoose option (1-3): ');
    
    switch (choice.trim()) {
      case '1':
        this.baseUrl = DEFAULT_BASE_URL;
        this.jobManager.baseUrl = this.baseUrl;
        console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        break;
      case '2':
        this.baseUrl = PRODUCTION_URL;
        this.jobManager.baseUrl = this.baseUrl;
        console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        break;
      case '3':
        const customUrl = await this.question('Enter custom URL: ');
        if (customUrl.trim()) {
          this.baseUrl = customUrl.trim().replace(/\/$/, ''); // Remove trailing slash
          this.jobManager.baseUrl = this.baseUrl;
          console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        }
        break;
      default:
        console.log('❌ Invalid choice');
    }
  }

  async testConnectivity() {
    console.log(`\n🌐 Test Connectivity\n`);
    console.log(`Testing endpoint: ${this.baseUrl}`);
    
    const loader = new LoadingIndicator();
    loader.start('🔍 Testing connection...', 'dots', '\x1b[36m');
    
    const startTime = Date.now();
    const pingResult = await this.pingEndpoint();
    const responseTime = Date.now() - startTime;
    
    loader.stop();
    
    console.log(`\n📊 Test Results:`);
    console.log(`─────────────────────────────────────────────────────────────`);
    console.log(`🔗 Endpoint: ${this.baseUrl}`);
    console.log(`⏱️  Response Time: ${responseTime}ms`);
    
    if (pingResult.online) {
      console.log(`✅ Status: ${AnimatedText.glow('ONLINE')}`);
      console.log(`📡 HTTP Status: ${pingResult.status}`);
      console.log(`💬 Message: ${pingResult.message}`);
      console.log(`\n🎉 Great! Your endpoint is working perfectly.`);
    } else {
      console.log(`❌ Status: ${AnimatedText.rainbow('OFFLINE')}`);
      console.log(`📡 Error Type: ${pingResult.status}`);
      console.log(`💬 Message: ${pingResult.message}`);
      
      console.log(`\n🔧 Troubleshooting Tips:`);
      
      if (pingResult.status === 'connection_failed') {
        console.log(`   • Check if your worker is running: npm run dev`);
        console.log(`   • Verify the endpoint URL is correct`);
        console.log(`   • Ensure the port is not blocked by firewall`);
      } else if (pingResult.status === 'timeout') {
        console.log(`   • Server might be overloaded or slow`);
        console.log(`   • Check your internet connection`);
        console.log(`   • Try a different endpoint if available`);
      } else if (typeof pingResult.status === 'number' && pingResult.status >= 400) {
        console.log(`   • Server returned HTTP ${pingResult.status} error`);
        console.log(`   • Check server logs for more details`);
        console.log(`   • Verify the /health endpoint exists`);
      } else {
        console.log(`   • Unknown error occurred`);
        console.log(`   • Check network connectivity`);
        console.log(`   • Try changing endpoint (option 8)`);
      }
      
      const retry = await this.question('\nTry a different endpoint? (Y/n): ');
      if (retry.trim() === '' || retry.toLowerCase().startsWith('y')) {
        await this.changeEndpoint();
      }
    }
  }

  async showHelp() {
    console.log(`
┌─────────────────────────────────────────────────────────────┐
│                     Help & Examples                        │
└─────────────────────────────────────────────────────────────┘

🎯 Processing Tiers (Automatic Detection):
┌─────────────┬─────────────┬─────────────────────────────────┐
│ Tier        │ File Size   │ Features                        │
├─────────────┼─────────────┼─────────────────────────────────┤
│ Standard    │ ≤ 15MB      │ Direct processing, fastest      │
│ Advanced    │ 15MB-100MB  │ Chunking, progress tracking     │
│ Enterprise  │ > 100MB     │ Advanced chunking, monitoring   │
└─────────────┴─────────────┴─────────────────────────────────┘

📤 Upload Methods:

1. Direct Upload (Recommended)
   • Best for: Web forms, mobile apps, simple integrations
   • Complexity: ⭐ Simple
   • Single-step process with immediate processing

2. URL Upload
   • Best for: Processing audio from web URLs, podcasts
   • Complexity: ⭐ Simple  
   • Downloads and processes files from any public URL

3. Presigned Upload (Advanced)
   • Best for: Large files, custom upload logic
   • Complexity: ⭐⭐ Advanced
   • Two-step process for maximum control

4. Streaming Upload (Real-time)
   • Best for: Testing, real-time feedback, development
   • Complexity: ⭐ Simple

5. Chunked Upload Streaming (Large files, fastest)
   • Best for: Large files (>5MB), fastest time to first result
   • Complexity: ⭐⭐ Advanced
   • Parallel chunk upload and processing with real-time streaming
   • Processes audio in tiny chunks with live results

💡 Pro Tips:
• LLM correction is enabled by default for better transcript quality
• Transcripts are automatically saved to file by default
• Use option 10 to test server connectivity before uploads
• Monitor progress for large files
• Save job IDs to retrieve results later
• Files are automatically cleaned up after 24 hours

🎵 Supported Formats:
Audio: MP3, WAV, FLAC, M4A, OGG, AAC, WMA
Video: MP4, MPEG, WEBM (audio track extracted)
`);
  }

  async directUpload() {
    console.log(`\n📤 Direct Upload\n`);
    
    const filePath = await this.question('Enter file path: ');
    
    if (!existsSync(filePath)) {
      console.log('❌ File not found');
      return;
    }

    const stats = statSync(filePath);
    const fileSize = stats.size;
    const filename = basename(filePath);
    
    console.log(`📁 File: ${filename}`);
    console.log(`📊 Size: ${this.formatBytes(fileSize)}`);
    console.log(`🎯 Processing tier: ${fileSize <= 15 * 1024 * 1024 ? 'Standard' : fileSize <= 100 * 1024 * 1024 ? 'Advanced' : 'Enterprise'}`);
    const useLLM = await this.question('\nEnable LLM correction for better quality? (y/N): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

    // Check connectivity before proceeding
    if (!(await this.checkConnectivityBeforeOperation())) {
      return;
    }

    const loader = new LoadingIndicator();
    
    try {
      // Start upload animation
      loader.start('🚀 Preparing upload...', 'wave', '\x1b[33m');
      await this.sleep(500);
      
      // Create FormData equivalent
      const fileBuffer = readFileSync(filePath);
      const formData = new FormData();
      
      const blob = new Blob([fileBuffer], { 
        type: this.getContentType(extname(filename)) 
      });
      
      formData.append('file', blob, filename);
      formData.append('use_llm', useLLM.toLowerCase().startsWith('y') ? 'true' : 'false');
      
      if (webhookUrl.trim()) {
        formData.append('webhook_url', webhookUrl.trim());
      }

      loader.stop();
      loader.start('📤 Uploading file to server...', 'dots', '\x1b[36m');

      const response = await fetch(`${this.baseUrl}/upload`, {
        method: 'POST',
        body: formData
      });

      const result = await response.json();
      loader.stop();

      if (!response.ok) {
        console.log(`❌ Upload failed: ${result.error || 'Unknown error'}`);
        return;
      }

      console.log('✅ Upload successful!');
      console.log(`📋 Job ID: ${result.job_id}`);
      console.log(`📁 Filename: ${result.filename}`);
      console.log(`📊 File size: ${this.formatBytes(result.file_size)}`);
      console.log(`⚙️  Processing method: ${result.processing_method}`);

      // Monitor progress
      await this.jobManager.monitorJob(result.job_id, true);

    } catch (error) {
      loader.stop();
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async urlUpload() {
    console.log(`\n🌐 URL Upload\n`);
    
    const url = await this.question('Enter audio URL: ');
    if (!url.trim()) {
      console.log('❌ URL is required');
      return;
    }

    const filename = await this.question('Custom filename (optional, press Enter to auto-detect): ');
    const useLLM = await this.question('\nEnable LLM correction for better quality? (y/N): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

    // Check connectivity before proceeding
    if (!(await this.checkConnectivityBeforeOperation())) {
      return;
    }

    const loader = new LoadingIndicator();

    try {
      const payload = {
        url: url.trim(),
        use_llm: useLLM.toLowerCase().startsWith('y'),
      };

      if (filename.trim()) {
        payload.filename = filename.trim();
      }

      if (webhookUrl.trim()) {
        payload.webhook_url = webhookUrl.trim();
      }

      loader.start('🔗 Connecting to server...', 'pulse', '\x1b[35m');
      console.log(`\n🔗 Connecting to: ${this.baseUrl}/upload-url`);
      console.log(`📤 Payload:`, JSON.stringify(payload, null, 2));
      
      loader.stop();
      loader.start('🌐 Downloading and processing file...', 'earth', '\x1b[32m');

      const response = await fetch(`${this.baseUrl}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      loader.stop();
      console.log(`📡 Response status: ${response.status} ${response.statusText}`);
      
      let result;
      try {
        result = await response.json();
      } catch (jsonError) {
        console.log(`❌ Failed to parse JSON response: ${jsonError.message}`);
        const textResponse = await response.text();
        console.log(`📄 Raw response: ${textResponse}`);
        return;
      }

      if (!response.ok) {
        console.log(`❌ Upload failed: ${result.error || 'Unknown error'}`);
        if (result.details) {
          console.log(`   Details: ${result.details}`);
        }
        if (result.status && result.statusText) {
          console.log(`   HTTP Status: ${result.status} ${result.statusText}`);
        }
        if (result.url) {
          console.log(`   URL: ${result.url}`);
        }
        if (result.original_url && result.original_url !== result.url) {
          console.log(`   Original URL: ${result.original_url}`);
        }
        if (result.error_type) {
          console.log(`   Error Type: ${result.error_type}`);
        }
        return;
      }

      console.log('✅ Download and upload successful!');
      console.log(`📋 Job ID: ${result.job_id}`);
      console.log(`📁 Filename: ${result.filename}`);
      console.log(`🌐 Source URL: ${result.source_url}`);
      console.log(`📊 File size: ${this.formatBytes(result.file_size)}`);
      console.log(`⚙️  Processing method: ${result.processing_method}`);

      // Monitor progress
      await this.jobManager.monitorJob(result.job_id, true);

    } catch (error) {
      loader.stop();
      console.log(`❌ Error: ${error.message}`);
      console.log(`🔍 Error type: ${error.name}`);
      console.log(`🔍 Error stack: ${error.stack}`);
      
      if (error.cause) {
        console.log(`🔍 Error cause: ${error.cause}`);
      }
      
      // Check if it's a network connectivity issue
      if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
        console.log(`\n💡 This looks like a connectivity issue. Please check:`);
        console.log(`   1. Is your worker running? Try: npm run dev`);
        console.log(`   2. Is the endpoint correct? Current: ${this.baseUrl}`);
        console.log(`   3. Are you connected to the internet?`);
        console.log(`   4. Try testing with: curl ${this.baseUrl}/upload-url`);
      }
    }
  }

  async presignedUpload() {
    console.log(`\n🔧 Presigned Upload (Advanced)\n`);
    
    const filePath = await this.question('Enter file path: ');
    
    if (!existsSync(filePath)) {
      console.log('❌ File not found');
      return;
    }

    const stats = statSync(filePath);
    const fileSize = stats.size;
    const filename = basename(filePath);
    
    console.log(`📁 File: ${filename}`);
    console.log(`📊 Size: ${this.formatBytes(fileSize)}`);

    const useLLM = await this.question('\nEnable LLM correction for better quality? (y/N): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

    // Check connectivity before proceeding
    if (!(await this.checkConnectivityBeforeOperation())) {
      return;
    }

    try {
      const loader = new LoadingIndicator();

      // Step 1: Get presigned URL
      loader.start('🔗 Step 1: Getting presigned URL...', 'arrow', '\x1b[33m');
      
      const payload = {
        filename,
        size: fileSize,
        use_llm: useLLM.toLowerCase().startsWith('y'),
      };

      if (webhookUrl.trim()) {
        payload.webhook_url = webhookUrl.trim();
      }

      const presignResponse = await fetch(`${this.baseUrl}/get-presigned-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const presignResult = await presignResponse.json();

      if (!presignResponse.ok) {
        loader.stop();
        console.log(`❌ Failed to get presigned URL: ${presignResult.error || 'Unknown error'}`);
        return;
      }

      loader.stop('✅ Presigned URL obtained');
      console.log(`📋 Job ID: ${presignResult.job_id}`);

      // Step 2: Upload file
      loader.start('📤 Step 2: Uploading file to cloud storage...', 'wave', '\x1b[36m');
      
      const fileBuffer = readFileSync(filePath);
      
      const uploadResponse = await fetch(presignResult.upload_url, {
        method: 'PUT',
        body: fileBuffer,
        headers: {
          'Content-Type': this.getContentType(extname(filename))
        }
      });

      if (!uploadResponse.ok) {
        loader.stop();
        console.log(`❌ File upload failed: ${uploadResponse.statusText}`);
        return;
      }

      loader.stop('✅ File uploaded successfully');

      // Step 3: Start processing
      loader.start('⚙️  Step 3: Starting transcription processing...', 'star', '\x1b[32m');
      
      const startResponse = await fetch(`${this.baseUrl}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: presignResult.job_id })
      });

      const startResult = await startResponse.json();

      if (!startResponse.ok) {
        loader.stop();
        console.log(`❌ Failed to start processing: ${startResult.error || 'Unknown error'}`);
        return;
      }

      loader.stop('✅ Processing started');
      console.log(`📊 File size: ${this.formatBytes(startResult.file_size)}`);
      console.log(`⚙️  Processing method: ${startResult.processing_method}`);

      // Monitor progress
      await this.jobManager.monitorJob(presignResult.job_id, true);

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }



  createProgressBar(progress, width = 30) {
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }

  async streamingUpload() {
    console.log(`\n🌊 Streaming Upload (Real-time results)\n`);
    console.log('📖 This method processes audio in tiny chunks and streams results in real-time');
    console.log('💡 Perfect for testing the streaming API or getting incremental results\n');
    
    // Option to upload file or URL
    const sourceType = await this.question('Upload source:\n1. 📁 File\n2. 🌐 URL\nChoose (1-2): ');
    
    let audioSource = {};
    
    if (sourceType.trim() === '1') {
      const filePath = await this.question('Enter file path: ');
      
      if (!existsSync(filePath)) {
        console.log('❌ File not found');
        return;
      }

      const stats = statSync(filePath);
      const fileSize = stats.size;
      const filename = basename(filePath);
      
      console.log(`📁 File: ${filename}`);
      console.log(`📊 Size: ${this.formatBytes(fileSize)}`);
      
      audioSource = { type: 'file', filePath, filename, fileSize };
      
    } else if (sourceType.trim() === '2') {
      const url = await this.question('Enter audio URL: ');
      if (!url.trim()) {
        console.log('❌ URL is required');
        return;
      }
      
      console.log(`🌐 URL: ${url}`);
      audioSource = { type: 'url', url };
      
    } else {
      console.log('❌ Invalid choice');
      return;
    }
    
    // Streaming settings
    const chunkSizeMB = await this.question('Chunk size in MB (default 0.25MB for fast streaming): ');
    const useLLM = await this.question('Enable LLM correction? (y/N): ');
    
    let llmMode = 'per_chunk';
    if (useLLM.toLowerCase().startsWith('y')) {
      const mode = await this.question('LLM mode:\n1. Per-chunk (real-time, faster)\n2. Post-process (full context, slower)\nChoose (1-2, default 1): ');
      llmMode = mode.trim() === '2' ? 'post_process' : 'per_chunk';
    }
    
    const finalChunkSize = parseFloat(chunkSizeMB.trim()) || 0.25;
    const enableLLM = useLLM.toLowerCase().startsWith('y');
    
    console.log(`\n⚙️  Settings:`);
    console.log(`   • Chunk size: ${finalChunkSize}MB`);
    console.log(`   • LLM correction: ${enableLLM ? 'Enabled' : 'Disabled'}`);
    if (enableLLM) {
      console.log(`   • LLM mode: ${llmMode === 'per_chunk' ? 'Per-chunk (real-time)' : 'Post-process (full context)'}`);
    }
    console.log(`   • Streaming: Real-time results\n`);

    // Check connectivity before proceeding
    if (!(await this.checkConnectivityBeforeOperation())) {
      return;
    }

    try {
      console.log('🚀 Starting streaming transcription...\n');
      
      let requestBody, headers;
      
      if (audioSource.type === 'file') {
        // File upload using FormData
        const fileBuffer = readFileSync(audioSource.filePath);
        const formData = new FormData();
        
        const blob = new Blob([fileBuffer], { 
          type: this.getContentType(extname(audioSource.filename)) 
        });
        
        formData.append('file', blob, audioSource.filename);
        formData.append('chunk_size_mb', finalChunkSize.toString());
        formData.append('use_llm', enableLLM.toString());
        if (enableLLM) {
          formData.append('llm_mode', llmMode);
        }
        
        requestBody = formData;
        headers = {}; // Let fetch set Content-Type for FormData
        
      } else {
        // URL upload using JSON
        const jsonPayload = {
          url: audioSource.url,
          chunk_size_mb: finalChunkSize,
          use_llm: enableLLM
        };
        
        if (enableLLM) {
          jsonPayload.llm_mode = llmMode;
        }
        
        requestBody = JSON.stringify(jsonPayload);
        headers = { 'Content-Type': 'application/json' };
      }
      
      const response = await fetch(`${this.baseUrl}/stream`, {
        method: 'POST',
        headers,
        body: requestBody
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`❌ Streaming failed: ${errorText}`);
        return;
      }
      
      // Process the streaming response
      await this.processStreamingResponse(response);
      
    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }
  
  async processStreamingResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    let fullTranscript = '';
    let chunkCount = 0;
    const startTime = Date.now();
    let buffer = '';
    
    cliLogger.stream('Processing streaming response...');
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          // Process any remaining data in buffer
          if (buffer.trim()) {
            this.processBufferLines(buffer, { fullTranscript, chunkCount, startTime });
          }
          cliLogger.complete('Streaming completed!');
          break;
        }
        
        // Decode chunk and add to buffer
        const chunk = decoder.decode(value, { stream: true });
        
        buffer += chunk;
        
        // Process complete lines immediately
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              // Process each event immediately and yield control
              await this.handleStreamEvent(data, { 
                fullTranscript, 
                chunkCount, 
                startTime 
              });
              
              // Update tracking variables
              if (data.type === 'delta') {
                const text = data.text || data.raw_text || '';
                fullTranscript += (fullTranscript ? ' ' : '') + text;
                chunkCount++;
              }
              
            } catch (parseError) {
              // Skip invalid JSON lines
              continue;
            }
          }
        }
      }
      
      // Show final summary
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      cliLogger.stats('Streaming summary', {
        chunks_processed: chunkCount,
        processing_time: `${duration}s`,
        transcript_length: fullTranscript.length
      });
      
             // Ask to save transcript
       if (fullTranscript) {
         try {
           const save = await this.question('\nSave transcript to file? (Y/n): ');
           if (save.trim() === '' || save.toLowerCase().startsWith('y')) {
             const filename = await this.question('Enter filename (default: streaming_transcript.txt): ');
             const outputFile = filename.trim() || 'streaming_transcript.txt';
             
             try {
               const fs = await import('fs');
               
               // For now, save the full transcript (we'll get final from the 'done' event)
               fs.writeFileSync(outputFile, fullTranscript);
               cliLogger.complete(`Transcript saved`, { filename: outputFile });
               
             } catch (error) {
               cliLogger.error('Failed to save transcript file', error);
             }
           }
         } catch (readlineError) {
           // Handle case where readline is closed during streaming
           console.log(`\n💾 Auto-saving transcript to streaming_transcript.txt...`);
           try {
             const fs = await import('fs');
             fs.writeFileSync('streaming_transcript.txt', fullTranscript);
             console.log(`✅ Transcript auto-saved to: streaming_transcript.txt`);
           } catch (error) {
             console.log(`❌ Error auto-saving file: ${error.message}`);
           }
         }
       }
      
    } catch (error) {
      cliLogger.error('Error processing stream', error);
    }
  }
  
  processBufferLines(buffer, context) {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          this.handleStreamEvent(data, context);
          
          // Update tracking variables
          if (data.type === 'delta') {
            const text = data.text || data.raw_text || '';
            context.fullTranscript += (context.fullTranscript ? ' ' : '') + text;
            context.chunkCount++;
          }
        } catch (parseError) {
          // Skip invalid JSON lines
          continue;
        }
      }
    }
  }

  async handleStreamEvent(data, context) {
    const { type } = data;
    
    switch (type) {
      case 'status':
        console.log(`📋 ${data.message}`);
        console.log(`   • File: ${data.filename}`);
        console.log(`   • Size: ${this.formatBytes(data.total_size)}`);
        console.log(`   • Estimated chunks: ${data.estimated_chunks}\n`);
        break;
        
      case 'chunk_info':
        console.log(`🧩 Ready to process ${data.total_chunks} chunks (${data.chunk_size_mb}MB each)\n`);
        break;
        
             case 'chunk_start':
         process.stdout.write(`\n🔄 Chunk ${data.chunk_index + 1} (${data.progress}%) - transcribing...`);
         break;
         
       case 'delta':
         // Print the incremental text immediately after transcription
         if (data.llm_applied) {
           process.stdout.write(`\n📝 Raw: "${data.raw_text}"`);
           process.stdout.write(`\n🧠 LLM: "${data.corrected_text}"`);
         } else if (data.llm_error) {
           process.stdout.write(`\n📝 "${data.raw_text}"`);
           process.stdout.write(`\n⚠️  LLM failed: ${data.llm_error}`);
         } else {
           // Backward compatibility or no LLM
           const text = data.text || data.raw_text;
           process.stdout.write(`\n📝 "${text}"`);
         }
         break;
         
       case 'chunk_done':
         process.stdout.write(` ✅ (${data.progress}%)\n`);
         break;
        
      case 'chunk_error':
        process.stdout.write(`❌ Error: ${data.error}\n`);
        break;
        
             case 'llm_processing':
         const mode = data.mode === 'post_process' ? 'post-processing' : 'per-chunk';
         console.log(`\n🧠 ${data.message || `Applying LLM corrections (${mode})...`}`);
         break;
         
       case 'llm_done':
         const doneMode = data.mode === 'post_process' ? 'Post-processing' : 'Per-chunk';
         console.log(`✅ ${doneMode} LLM correction completed`);
         if (data.mode === 'post_process') {
           console.log(`📝 Improved transcript:`);
           console.log(`"${data.corrected_text}"\n`);
         }
         break;
         
       case 'llm_error':
         const errorMode = data.mode === 'post_process' ? 'Post-processing' : 'Per-chunk';
         console.log(`❌ ${errorMode} LLM correction failed: ${data.error}`);
         if (data.fallback_text) {
           console.log(`📝 Using original transcript: "${data.fallback_text}"\n`);
         }
         break;
        
             case 'done':
         console.log(`\n🎉 Transcription completed!`);
         console.log(`📊 Total segments: ${data.total_segments}`);
         
         if (data.llm_correction_applied && data.corrected_transcript) {
           console.log(`📝 Raw transcript:`);
           console.log(`"${data.raw_transcript}"`);
           console.log(`\n🧠 LLM-corrected transcript:`);
           console.log(`"${data.corrected_transcript}"`);
         } else {
           console.log(`📝 Final transcript:`);
           console.log(`"${data.final_transcript}"`);
         }
         break;
        
      case 'error':
        console.log(`❌ Stream error: ${data.error}`);
        break;
        
      default:
        // Handle unknown event types gracefully
        console.log(`📨 ${type}: ${JSON.stringify(data)}`);
    }
  }

  async chunkedUploadStreaming() {
    console.log(`\n⚡ Chunked Upload Streaming (Large files, fastest)\n`);
    console.log('📖 This method uploads large files in chunks with parallel processing');
    console.log('💡 Perfect for large files - get the first transcription results immediately!\n');
    
    // Get file path
    const filePath = await this.question('Enter file path: ');
    
    if (!existsSync(filePath)) {
      console.log('❌ File not found');
      return;
    }

    const stats = statSync(filePath);
    const fileSize = stats.size;
    const filename = basename(filePath);
    const minSize = 5 * 1024 * 1024; // 5MB minimum
    
    console.log(`📁 File: ${filename}`);
    console.log(`📊 Size: ${this.formatBytes(fileSize)}`);
    
    if (fileSize < minSize) {
      console.log(`⚠️  File is smaller than 5MB. Consider using regular streaming upload (option 4) for better performance.`);
      const proceed = await this.question('Continue anyway? (y/N): ');
      if (!proceed.toLowerCase().startsWith('y')) {
        return;
      }
    }
    
    // Chunked upload settings
    const chunkSizeMB = await this.question('Chunk size in MB (default 5MB, range 1-100): ');
    const useLLM = await this.question('Enable LLM correction? (y/N): ');
    
    let llmMode = 'per_chunk';
    if (useLLM.toLowerCase().startsWith('y')) {
      const mode = await this.question('LLM mode:\n1. Per-chunk (real-time, faster)\n2. Post-process (full context, slower)\nChoose (1-2, default 1): ');
      llmMode = mode.trim() === '2' ? 'post_process' : 'per_chunk';
    }
    
    const finalChunkSize = Math.max(1, Math.min(100, parseFloat(chunkSizeMB.trim()) || 5));
    const enableLLM = useLLM.toLowerCase().startsWith('y');
    const maxConcurrentUploads = 3; // Safe default for parallel uploads
    
    console.log(`\n⚙️  Settings:`);
    console.log(`   • Chunk size: ${finalChunkSize}MB`);
    console.log(`   • LLM correction: ${enableLLM ? 'Enabled' : 'Disabled'}`);
    if (enableLLM) {
      console.log(`   • LLM mode: ${llmMode === 'per_chunk' ? 'Per-chunk (real-time)' : 'Post-process (full context)'}`);
    }
    console.log(`   • Max concurrent uploads: ${maxConcurrentUploads}`);
    console.log(`   • Processing: Parallel chunks with real-time streaming\n`);

    // Check connectivity before proceeding
    if (!(await this.checkConnectivityBeforeOperation())) {
      return;
    }

    try {
      console.log('🚀 Initializing chunked upload streaming...\n');
      
      // Step 1: Initialize chunked upload session
      const initResponse = await fetch(`${this.baseUrl}/chunked-upload-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename,
          total_size: fileSize,
          chunk_size_mb: finalChunkSize,
          use_llm: enableLLM,
          llm_mode: llmMode,
          max_concurrent_uploads: maxConcurrentUploads
        })
      });
      
      if (!initResponse.ok) {
        const errorText = await initResponse.text();
        console.log(`❌ Initialization failed: ${errorText}`);
        return;
      }
      
      const { parent_job_id, upload_urls, stream_url, chunk_info } = await initResponse.json();
      
      console.log(`✅ Session initialized successfully!`);
      console.log(`📋 Job ID: ${parent_job_id}`);
      console.log(`🧩 Total chunks: ${chunk_info.total_chunks}`);
      console.log(`⏱️  Estimated time: ${chunk_info.estimated_processing_time}\n`);
      
      // Step 2: Start SSE stream for real-time updates
      console.log('🌊 Opening real-time stream...\n');
      const streamPromise = this.handleChunkedStream(stream_url, parent_job_id);
      
      // Step 3: Upload chunks in parallel
      console.log('📤 Starting parallel chunk uploads...\n');
      const uploadPromise = this.uploadChunksInParallel(filePath, upload_urls, parent_job_id, maxConcurrentUploads);
      
      // Wait for both streaming and uploading to complete
      await Promise.all([streamPromise, uploadPromise]);
      
    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async handleChunkedStream(streamUrl, parentJobId) {
    try {
      const response = await fetch(`${this.baseUrl}${streamUrl}`, {
        method: 'GET',
        headers: { 'Accept': 'text/event-stream' }
      });
      
      if (!response.ok) {
        throw new Error(`Stream failed: ${response.status}`);
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullTranscript = '';
      let lastPartialTranscript = '';
      const startTime = Date.now();
      let firstResultTime = null;
      let completedChunks = 0;
      let totalChunks = 0;
      
      console.log('📡 Real-time stream connected!\n');
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            console.log('\n🔚 Stream ended');
            break;
          }
          
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                await this.handleChunkedStreamEvent(data, {
                  fullTranscript,
                  lastPartialTranscript,
                  startTime,
                  firstResultTime,
                  completedChunks,
                  totalChunks,
                  parentJobId
                });
                
                // Update context variables
                if (data.type === 'initialized') {
                  totalChunks = data.total_chunks;
                }
                if (data.type === 'chunk_complete') {
                  completedChunks++;
                  if (!firstResultTime) {
                    firstResultTime = Date.now();
                    const timeToFirst = ((firstResultTime - startTime) / 1000).toFixed(1);
                    console.log(`\n⚡ First result in ${timeToFirst}s! (${((completedChunks / totalChunks) * 100).toFixed(1)}% complete)\n`);
                  }
                }
                if (data.type === 'partial_transcript') {
                  lastPartialTranscript = data.partial_transcript;
                }
                if (data.type === 'final_result') {
                  fullTranscript = data.final_transcript;
                }
                
              } catch (parseError) {
                continue; // Skip invalid JSON
              }
            }
          }
        }
        
        // Show final summary
        if (fullTranscript) {
          const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
          const timeToFirst = firstResultTime ? ((firstResultTime - startTime) / 1000).toFixed(1) : 'N/A';
          
          console.log(`\n📊 Final Summary:`);
          console.log(`   • Total time: ${totalTime}s`);
          console.log(`   • Time to first result: ${timeToFirst}s`);
          console.log(`   • Transcript length: ${fullTranscript.length} characters`);
          console.log(`   • Chunks processed: ${completedChunks}/${totalChunks}\n`);
          
          // Ask to save transcript
          try {
            const save = await this.question('Save transcript to file? (Y/n): ');
            if (save.trim() === '' || save.toLowerCase().startsWith('y')) {
              const outputFilename = await this.question('Enter filename (default: chunked_transcript.txt): ');
              const outputFile = outputFilename.trim() || 'chunked_transcript.txt';
              
              const fs = await import('fs');
              fs.writeFileSync(outputFile, fullTranscript);
              console.log(`✅ Transcript saved to: ${outputFile}`);
            }
          } catch (readlineError) {
            // Auto-save if readline is closed
            console.log(`💾 Auto-saving transcript...`);
            const fs = await import('fs');
            fs.writeFileSync('chunked_transcript.txt', fullTranscript);
            console.log(`✅ Transcript auto-saved to: chunked_transcript.txt`);
          }
        }
        
      } catch (streamError) {
        console.log(`❌ Stream error: ${streamError.message}`);
      }
      
    } catch (error) {
      console.log(`❌ Failed to connect to stream: ${error.message}`);
    }
  }

  async handleChunkedStreamEvent(data, context) {
    const { type } = data;
    
    switch (type) {
      case 'initialized':
        console.log(`📋 Session ready: ${data.filename}`);
        console.log(`🧩 Will process ${data.total_chunks} chunks`);
        console.log(`⚙️  Processing options: ${JSON.stringify(data.processing_options)}\n`);
        break;
        
      case 'progress_update':
        const uploadPct = data.upload_progress || 0;
        const processPct = data.processing_progress || 0;
        process.stdout.write(`\r📊 Progress: Upload ${uploadPct}% | Processing ${processPct}% | Completed ${data.completed_chunks}/${data.completed_chunks + data.failed_chunks + (data.uploaded_chunks - data.completed_chunks - data.failed_chunks)} chunks`);
        break;
        
      case 'chunk_complete':
        const timeElapsed = ((Date.now() - context.startTime) / 1000).toFixed(1);
        process.stdout.write(`\n✅ Chunk ${data.chunk_index + 1} completed (${timeElapsed}s)`);
        if (data.text) {
          if (data.llm_applied) {
            console.log(`\n   📝 Raw: "${data.raw_text}"`);
            console.log(`   🧠 LLM: "${data.corrected_text}"`);
          } else {
            console.log(`\n   📝 "${data.text}"`);
          }
        }
        break;
        
      case 'chunk_failed':
        console.log(`\n❌ Chunk ${data.chunk_index + 1} failed: ${data.error}`);
        break;
        
      case 'partial_transcript':
        if (data.partial_transcript && data.partial_transcript !== context.lastPartialTranscript) {
          console.log(`\n🔄 Partial transcript (${data.available_chunks}/${data.total_chunks} chunks):`);
          console.log(`"${data.partial_transcript}"\n`);
        }
        break;
        
      case 'assembly_start':
        console.log(`\n🔧 Assembling final transcript from ${data.completed_chunks} chunks...`);
        break;
        
      case 'assembly_complete':
        console.log(`✅ Assembly completed: ${data.successful_chunks}/${data.total_chunks} chunks successful`);
        break;
        
      case 'llm_processing':
        console.log(`\n🧠 ${data.message || 'Applying LLM corrections...'}`);
        break;
        
      case 'llm_done':
        console.log(`✅ LLM correction completed (${data.mode || 'unknown'} mode)`);
        break;
        
      case 'llm_error':
        console.log(`❌ LLM correction failed: ${data.error} (using fallback)`);
        break;
        
      case 'final_result':
        console.log(`\n🎉 Chunked upload streaming completed!`);
        console.log(`📊 Final stats:`);
        console.log(`   • Status: ${data.status}`);
        console.log(`   • Total chunks: ${data.total_chunks}`);
        console.log(`   • Successful: ${data.successful_chunks}`);
        console.log(`   • Failed: ${data.failed_chunks}`);
        console.log(`   • Success rate: ${data.success_rate}%`);
        if (data.processing_stats) {
          console.log(`   • Processing time: ${(data.processing_stats.total_processing_time / 1000).toFixed(1)}s`);
        }
        console.log(`\n📝 Final transcript:`);
        console.log(`"${data.final_transcript}"\n`);
        break;
        
      case 'job_terminated':
        console.log(`\n⚠️  Job terminated: ${data.status}`);
        console.log(`📋 Reason: ${data.reason}`);
        if (data.partial_results) {
          console.log(`📝 Partial results available (${data.partial_results.completed_chunks} chunks)`);
        }
        break;
        
      case 'stream_timeout':
        console.log(`\n⏰ Stream timeout (${data.duration_minutes} minutes)`);
        console.log(`💡 ${data.suggestion}`);
        break;
        
      case 'stream_error':
        if (data.recoverable) {
          console.log(`\n⚠️  Stream error (recoverable): ${data.error}`);
        } else {
          console.log(`\n❌ Stream error: ${data.error}`);
        }
        break;
        
      case 'error':
        console.log(`\n❌ Error: ${data.error}`);
        break;
        
      default:
        // Debug: show unknown events
        console.log(`\n📨 ${type}: ${JSON.stringify(data).slice(0, 100)}...`);
    }
  }

  async uploadChunksInParallel(filePath, uploadUrls, parentJobId, maxConcurrent) {
    const fs = await import('fs');
    const fileHandle = await fs.promises.open(filePath, 'r');
    
    console.log(`📤 Uploading ${uploadUrls.length} chunks (max ${maxConcurrent} concurrent)...\n`);
    
    try {
      // Create semaphore for concurrency control
      let currentConcurrent = 0;
      const uploadPromises = uploadUrls.map(async (urlInfo, index) => {
        // Wait for available slot
        while (currentConcurrent >= maxConcurrent) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        currentConcurrent++;
        
        try {
          // Read chunk data
          const chunkSize = urlInfo.byte_range[1] - urlInfo.byte_range[0] + 1;
          const buffer = Buffer.alloc(chunkSize);
          const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, urlInfo.byte_range[0]);
          
          if (bytesRead === 0) {
            throw new Error(`No data read for chunk ${urlInfo.chunk_index}`);
          }
          
          const actualChunkData = buffer.slice(0, bytesRead);
          
          console.log(`📤 Uploading chunk ${urlInfo.chunk_index + 1}/${uploadUrls.length} (${this.formatBytes(bytesRead)})...`);
          
          // Upload chunk
          const uploadResponse = await fetch(urlInfo.upload_url, {
            method: 'PUT',
            body: actualChunkData,
            headers: {
              'Content-Type': 'audio/*',
              'Content-Length': bytesRead.toString()
            }
          });
          
          if (!uploadResponse.ok) {
            throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
          }
          
          console.log(`✅ Chunk ${urlInfo.chunk_index + 1} uploaded successfully`);
          
          // Notify upload completion
          const completeResponse = await fetch(`${this.baseUrl}/chunk-upload-complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              parent_job_id: parentJobId,
              chunk_index: urlInfo.chunk_index,
              actual_size: bytesRead
            })
          });
          
          if (!completeResponse.ok) {
            const errorText = await completeResponse.text();
            throw new Error(`Failed to notify upload completion: ${errorText}`);
          }
          
          console.log(`🔄 Chunk ${urlInfo.chunk_index + 1} processing started`);
          
        } catch (error) {
          console.log(`❌ Chunk ${urlInfo.chunk_index + 1} failed: ${error.message}`);
          throw error;
        } finally {
          currentConcurrent--;
        }
      });
      
      // Wait for all uploads to complete
      const results = await Promise.allSettled(uploadPromises);
      
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      console.log(`\n📊 Upload Summary:`);
      console.log(`   • Successful: ${successful}/${uploadUrls.length}`);
      console.log(`   • Failed: ${failed}/${uploadUrls.length}`);
      console.log(`   • Success rate: ${((successful / uploadUrls.length) * 100).toFixed(1)}%\n`);
      
      if (failed > 0) {
        console.log(`⚠️  Some chunks failed to upload. Processing will continue with available chunks.`);
      }
      
    } finally {
      await fileHandle.close();
    }
  }

  getContentType(extension) {
    const contentTypes = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg',
      '.aac': 'audio/aac',
      '.wma': 'audio/x-ms-wma',
      '.mp4': 'video/mp4',
      '.mpeg': 'video/mpeg',
      '.webm': 'video/webm'
    };
    return contentTypes[extension.toLowerCase()] || 'audio/*';
  }

  async run() {
    await this.showWelcome();

    while (true) {
      try {
        const choice = await this.showMainMenu();

        switch (choice) {
          case '1':
            await this.directUpload();
            break;
          case '2':
            await this.urlUpload();
            break;
          case '3':
            await this.presignedUpload();
            break;
          case '4':
            await this.streamingUpload();
            break;
          case '5':
            await this.chunkedUploadStreaming();
            break;
          case '6':
            await this.jobManager.listJobs();
            break;
          case '7':
            await this.jobManager.checkJobStatus();
            break;
          case '8':
            await this.jobManager.getJobResults();
            break;
          case '9':
            await this.jobManager.deleteJob();
            break;
          case '10':
            await this.changeEndpoint();
            break;
          case '11':
            await this.showHelp();
            break;
          case '12':
            await this.testConnectivity();
            break;
          case '0':
            console.log('\n👋 Goodbye!');
            this.rl.close();
            process.exit(0);
            break;
          default:
            console.log('❌ Invalid choice. Please try again.');
        }

        // Wait for user to continue
        console.log('\n');
        try {
          await this.question('Press Enter to continue...');
          console.clear();
        } catch (readlineError) {
          // Handle case where readline was closed during streaming
          console.log('Returning to main menu...');
          console.clear();
        }

      } catch (error) {
        console.log(`❌ Unexpected error: ${error.message}`);
        try {
          await this.question('Press Enter to continue...');
        } catch (readlineError) {
          // Handle case where readline was closed
          console.log('Returning to main menu...');
        }
      }
    }
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('\n\n👋 Goodbye!');
  process.exit(0);
});

// Run the CLI
const cli = new GroqWhisperCLI();
cli.run().catch(console.error); 
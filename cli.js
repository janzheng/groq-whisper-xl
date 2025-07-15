#!/usr/bin/env node

import { readFileSync, existsSync, statSync } from 'fs';
import { createReadStream } from 'fs';
import { basename, extname } from 'path';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { config } from 'dotenv';

// Load environment variables
config();

// Configuration
const DEFAULT_BASE_URL = process.env.LOCAL_URL || 'http://localhost:8787';
const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://your-worker-name.your-subdomain.workers.dev';

class LoadingIndicator {
  constructor() {
    this.spinners = {
      dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      bounce: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
      pulse: ['◐', '◓', '◑', '◒'],
      clock: ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'],
      wave: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▁'],
      arrow: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
      box: ['▖', '▘', '▝', '▗'],
      star: ['✦', '✧', '✩', '✪', '✫', '✬', '✭', '✮', '✯', '✰'],
      earth: ['🌍', '🌎', '🌏'],
      moon: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘']
    };
    this.currentSpinner = null;
    this.currentInterval = null;
    this.currentFrame = 0;
    this.isActive = false;
  }

  start(message, type = 'dots', color = '\x1b[36m') {
    if (this.isActive) {
      this.stop();
    }

    this.isActive = true;
    this.currentFrame = 0;
    const frames = this.spinners[type] || this.spinners.dots;
    
    // Hide cursor
    process.stdout.write('\x1b[?25l');
    
    this.currentInterval = setInterval(() => {
      const frame = frames[this.currentFrame % frames.length];
      process.stdout.write(`\r${color}${frame}\x1b[0m ${message}`);
      this.currentFrame++;
    }, 100);

    return this;
  }

  stop(finalMessage = null, symbol = '✅') {
    if (this.currentInterval) {
      clearInterval(this.currentInterval);
      this.currentInterval = null;
    }
    
    if (this.isActive) {
      // Clear the line and show cursor
      process.stdout.write('\r' + ' '.repeat(100) + '\r');
      process.stdout.write('\x1b[?25h');
      
      if (finalMessage) {
        console.log(`${symbol} ${finalMessage}`);
      }
    }
    
    this.isActive = false;
    return this;
  }

  update(message) {
    if (this.isActive) {
      // The message will be updated on the next frame
      this.currentMessage = message;
    }
    return this;
  }

  static async withSpinner(message, asyncFn, type = 'dots') {
    const loader = new LoadingIndicator();
    loader.start(message, type);
    
    try {
      const result = await asyncFn();
      loader.stop();
      return result;
    } catch (error) {
      loader.stop(null, '❌');
      throw error;
    }
  }
}

class ProgressBar {
  constructor(total, width = 40) {
    this.total = total;
    this.current = 0;
    this.width = width;
    this.startTime = Date.now();
  }

  update(current, message = '') {
    this.current = current;
    const percentage = Math.min(100, Math.max(0, (current / this.total) * 100));
    const filled = Math.round((percentage / 100) * this.width);
    const empty = this.width - filled;
    
    const elapsed = Date.now() - this.startTime;
    const rate = current / (elapsed / 1000);
    const eta = current > 0 ? ((this.total - current) / rate) : 0;
    
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const stats = `${percentage.toFixed(1)}%`;
    const speed = rate > 0 ? ` | ${rate.toFixed(1)}/s` : '';
    const timeLeft = eta > 0 && eta < 3600 ? ` | ETA: ${Math.round(eta)}s` : '';
    
    const line = `\r[${bar}] ${stats}${speed}${timeLeft} ${message}`;
    process.stdout.write(line);
    
    return percentage >= 100;
  }

  finish(message = 'Complete!') {
    this.update(this.total, message);
    console.log(); // New line
  }
}

class AnimatedText {
  static typewriter(text, speed = 50) {
    return new Promise((resolve) => {
      let i = 0;
      const interval = setInterval(() => {
        process.stdout.write(text[i]);
        i++;
        if (i >= text.length) {
          clearInterval(interval);
          console.log(); // New line
          resolve();
        }
      }, speed);
    });
  }

  static rainbow(text) {
    const colors = ['\x1b[31m', '\x1b[33m', '\x1b[32m', '\x1b[36m', '\x1b[34m', '\x1b[35m'];
    return text.split('').map((char, i) => 
      `${colors[i % colors.length]}${char}\x1b[0m`
    ).join('');
  }

  static glow(text) {
    return `\x1b[1m\x1b[93m${text}\x1b[0m`;
  }
}

class GroqWhisperCLI {
  constructor() {
    this.baseUrl = DEFAULT_BASE_URL;
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
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

  async showWelcome() {
    console.clear();
    
    // Animated welcome
    const title = `
╔══════════════════════════════════════════════════════════════╗
║                    🎤 Groq Whisper XL CLI                   ║
║              Universal Audio Transcription Tool             ║
╚══════════════════════════════════════════════════════════════╝`;

    console.log(AnimatedText.glow(title));
    
    const loader = new LoadingIndicator();
    loader.start('🚀 Initializing system...', 'star', '\x1b[35m');
    await this.sleep(800);
    loader.stop();

    console.log(`
${AnimatedText.rainbow('✨ Features:')}
• 🚀 Ultra-fast transcription using Groq's Whisper API
• 📁 Universal file support (MB to 100GB+)
• 🎯 Smart tier detection (Standard/Advanced/Enterprise)
• 🤖 LLM error correction for improved accuracy
• 🌐 URL-based audio processing
• 📊 Real-time progress tracking

Current endpoint: ${AnimatedText.glow(this.baseUrl)}
`);
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
│                                                             │
│ Job Management:                                             │
│   4. 📋 List Jobs                                           │
│   5. 📊 Check Job Status                                    │
│   6. 📄 Get Job Results                                     │
│   7. 🗑️  Delete Job                                          │
│                                                             │
│ Settings:                                                   │
│   8. ⚙️  Change Endpoint                                     │
│   9. ❓ Help & Examples                                     │
│   0. 🚪 Exit                                                │
└─────────────────────────────────────────────────────────────┘
`);

    const choice = await this.question('Choose an option (0-9): ');
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
        console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        break;
      case '2':
        this.baseUrl = PRODUCTION_URL;
        console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        break;
      case '3':
        const customUrl = await this.question('Enter custom URL: ');
        if (customUrl.trim()) {
          this.baseUrl = customUrl.trim().replace(/\/$/, ''); // Remove trailing slash
          console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        }
        break;
      default:
        console.log('❌ Invalid choice');
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

💡 Pro Tips:
• Enable LLM correction for better transcript quality
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
    const useLLM = await this.question('\nEnable LLM correction for better quality? (Y/n): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

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
      await this.monitorJob(result.job_id, true);

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
    const useLLM = await this.question('\nEnable LLM correction for better quality? (Y/n): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

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
      await this.monitorJob(result.job_id, true);

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

    const useLLM = await this.question('\nEnable LLM correction for better quality? (Y/n): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

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
      await this.monitorJob(presignResult.job_id, true);

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async monitorJob(jobId, autoShowResults = false) {
    console.log(`\n📊 ${AnimatedText.glow('Monitoring job:')} ${jobId}`);
    console.log('Press Ctrl+C to stop monitoring (job will continue in background)\n');

    const startTime = Date.now();
    let lastStatus = '';
    let spinner = null;

    while (true) {
      try {
        const response = await fetch(`${this.baseUrl}/status?job_id=${jobId}`);
        const status = await response.json();

        if (!response.ok) {
          if (spinner) spinner.stop();
          console.log(`❌ Error checking status: ${status.error || 'Unknown error'}`);
          break;
        }

        const elapsed = this.formatDuration(Date.now() - startTime);
        const progress = status.progress || 0;
        
        // Use different spinner types based on status
        const spinnerType = {
          'uploaded': 'pulse',
          'processing': 'dots',
          'done': 'star',
          'failed': 'box'
        }[status.status] || 'dots';

        const statusColors = {
          'uploaded': '\x1b[33m',  // Yellow
          'processing': '\x1b[36m', // Cyan
          'done': '\x1b[32m',      // Green
          'failed': '\x1b[31m'     // Red
        };

        // If status changed, restart spinner
        if (status.status !== lastStatus) {
          if (spinner) spinner.stop();
          
          if (status.status === 'processing') {
            spinner = new LoadingIndicator();
            spinner.start(`🔄 Processing... ${progress}% | Elapsed: ${elapsed}`, spinnerType, statusColors[status.status]);
          } else if (status.status === 'uploaded') {
            spinner = new LoadingIndicator();
            spinner.start(`📁 File uploaded, waiting to start... | Elapsed: ${elapsed}`, spinnerType, statusColors[status.status]);
          }
        } else if (spinner && status.status === 'processing') {
          // Update the spinner message with current progress
          spinner.stop();
          spinner.start(`🔄 Processing... ${progress}% | Elapsed: ${elapsed}`, spinnerType, statusColors[status.status]);
        }

        if (status.status === 'done') {
          if (spinner) spinner.stop();
          
          // Show completion animation
          console.log('\n🎉 ' + AnimatedText.rainbow('Processing completed successfully!'));
          
          if (autoShowResults) {
            await this.getJobResults(jobId);
          } else {
            console.log(`\nTo get results, use option 6 with job ID: ${jobId}`);
          }
          break;
        } else if (status.status === 'failed') {
          if (spinner) spinner.stop();
          console.log(`\n\n❌ Processing failed: ${status.error || 'Unknown error'}`);
          break;
        }

        lastStatus = status.status;
        await this.sleep(1000); // Check every second for more responsive updates

      } catch (error) {
        if (spinner) spinner.stop();
        console.log(`\n❌ Error monitoring job: ${error.message}`);
        break;
      }
    }
  }

  createProgressBar(progress, width = 30) {
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }

  async listJobs() {
    console.log(`\n📋 Listing Jobs\n`);
    
    const limit = await this.question('Number of jobs to show (default 20): ');
    const statusFilter = await this.question('Filter by status (done/processing/failed, or press Enter for all): ');

    try {
      let url = `${this.baseUrl}/jobs`;
      const params = new URLSearchParams();
      
      if (limit.trim() && !isNaN(limit.trim())) {
        params.append('limit', limit.trim());
      } else {
        params.append('limit', '20');
      }
      
      if (statusFilter.trim()) {
        params.append('status', statusFilter.trim());
      }

      if (params.toString()) {
        url += '?' + params.toString();
      }

      const loader = new LoadingIndicator();
      loader.start('📋 Fetching job list...', 'dots', '\x1b[36m');

      const response = await fetch(url);
      const result = await response.json();
      
      loader.stop();

      if (!response.ok) {
        console.log(`❌ Error: ${result.error || 'Unknown error'}`);
        return;
      }

      if (result.jobs.length === 0) {
        console.log('📭 No jobs found');
        return;
      }

      console.log(`\n📊 Showing ${result.showing} of ${result.total} jobs:\n`);

      // Table header
      console.log('┌─────────────────────────────────────┬──────────────────┬───────────┬──────────┬──────────────┬─────────────────────┐');
      console.log('│ Job ID                              │ Filename         │ Status    │ Progress │ File Size    │ Created             │');
      console.log('├─────────────────────────────────────┼──────────────────┼───────────┼──────────┼──────────────┼─────────────────────┤');

      for (const job of result.jobs) {
        const jobId = job.job_id.substring(0, 35);
        const filename = (job.filename || 'Unknown').substring(0, 15);
        const status = job.status.substring(0, 10);
        const progress = `${job.progress || 0}%`.padStart(7);
        const fileSize = this.formatBytes(job.file_size || 0).substring(0, 11);
        const created = new Date(job.created_at).toLocaleString().substring(0, 18);

        console.log(`│ ${jobId.padEnd(35)} │ ${filename.padEnd(15)} │ ${status.padEnd(9)} │ ${progress} │ ${fileSize.padEnd(11)} │ ${created.padEnd(18)} │`);
      }

      console.log('└─────────────────────────────────────┴──────────────────┴───────────┴──────────┴──────────────┴─────────────────────┘');

      if (result.filters) {
        console.log(`\nFilters applied: ${JSON.stringify(result.filters)}`);
      }

    } catch (error) {
      if (typeof loader !== 'undefined') loader.stop();
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async checkJobStatus() {
    console.log(`\n📊 Check Job Status\n`);
    
    const jobId = await this.question('Enter job ID: ');
    if (!jobId.trim()) {
      console.log('❌ Job ID is required');
      return;
    }

    await this.monitorJob(jobId.trim(), false);
  }

  async getJobResults(jobId = null) {
    if (!jobId) {
      console.log(`\n📄 Get Job Results\n`);
      jobId = await this.question('Enter job ID: ');
      if (!jobId.trim()) {
        console.log('❌ Job ID is required');
        return;
      }
      jobId = jobId.trim();
    }

    try {
      const loader = new LoadingIndicator();
      loader.start('📄 Fetching transcription results...', 'wave', '\x1b[32m');
      
      const response = await fetch(`${this.baseUrl}/result?job_id=${jobId}`);
      const result = await response.json();
      
      loader.stop();

      if (!response.ok) {
        if (result.error === 'Not ready') {
          console.log(`⏳ Job not ready yet. Status: ${result.status}, Progress: ${result.progress}%`);
          const monitor = await this.question('Monitor progress? (y/N): ');
          if (monitor.toLowerCase().startsWith('y')) {
            await this.monitorJob(jobId, true);
          }
        } else {
          console.log(`❌ Error: ${result.error || 'Unknown error'}`);
        }
        return;
      }

      console.log('\n🎉 Transcription Results:\n');

      // Show final transcript
      console.log('📝 Final Transcript:');
      console.log('─'.repeat(80));
      console.log(result.final || 'No transcript available');
      console.log('─'.repeat(80));

      // Show partial results if available
      if (result.partials && result.partials.length > 1) {
        console.log(`\n📊 Processing Details (${result.partials.length} chunks):`);
        
        for (let i = 0; i < result.partials.length; i++) {
          const partial = result.partials[i];
          console.log(`\nChunk ${i + 1}:`);
          
          // Handle cases where text might be undefined/null (failed chunks)
          if (partial.text) {
            console.log(`  Text: ${partial.text.substring(0, 100)}${partial.text.length > 100 ? '...' : ''}`);
          } else {
            console.log(`  Text: [Chunk processing failed - no transcript available]`);
          }
          
          if (partial.segments && partial.segments.length > 0) {
            console.log(`  Segments: ${partial.segments.length}`);
            console.log(`  Duration: ${partial.segments[0].start}s - ${partial.segments[partial.segments.length - 1].end}s`);
          }
        }
      }

      // Ask to save results
      const save = await this.question('\nSave transcript to file? (y/N): ');
      if (save.toLowerCase().startsWith('y')) {
        const filename = await this.question('Enter filename (default: transcript.txt): ');
        const outputFile = filename.trim() || 'transcript.txt';
        
        try {
          const fs = await import('fs');
          fs.writeFileSync(outputFile, result.final || 'No transcript available');
          console.log(`✅ Transcript saved to: ${outputFile}`);
        } catch (error) {
          console.log(`❌ Error saving file: ${error.message}`);
        }
      }

    } catch (error) {
      if (typeof loader !== 'undefined') loader.stop();
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async deleteJob() {
    console.log(`\n🗑️ Delete Job\n`);
    
    const jobId = await this.question('Enter job ID to delete: ');
    if (!jobId.trim()) {
      console.log('❌ Job ID is required');
      return;
    }

    const confirm = await this.question(`⚠️  Are you sure you want to delete job ${jobId.trim()}? This will remove the job and its files. (y/N): `);
    if (!confirm.toLowerCase().startsWith('y')) {
      console.log('❌ Deletion cancelled');
      return;
    }

    try {
      const loader = new LoadingIndicator();
      loader.start('🗑️ Deleting job and cleaning up files...', 'box', '\x1b[31m');
      
      const response = await fetch(`${this.baseUrl}/delete-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId.trim() })
      });

      const result = await response.json();
      loader.stop();

      if (!response.ok) {
        console.log(`❌ Error: ${result.error || 'Unknown error'}`);
        return;
      }

      console.log('✅ Job deleted successfully');
      console.log(`📋 Job ID: ${result.job_id}`);
      console.log(`📁 Filename: ${result.filename}`);
      if (result.deleted_file) {
        console.log(`🗑️ Deleted file: ${result.deleted_file}`);
      }

    } catch (error) {
      if (typeof loader !== 'undefined') loader.stop();
      console.log(`❌ Error: ${error.message}`);
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
            await this.listJobs();
            break;
          case '5':
            await this.checkJobStatus();
            break;
          case '6':
            await this.getJobResults();
            break;
          case '7':
            await this.deleteJob();
            break;
          case '8':
            await this.changeEndpoint();
            break;
          case '9':
            await this.showHelp();
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
        await this.question('Press Enter to continue...');
        console.clear();

      } catch (error) {
        console.log(`❌ Unexpected error: ${error.message}`);
        await this.question('Press Enter to continue...');
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
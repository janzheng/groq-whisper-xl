/**
 * UI Helpers for Terminal Display
 * Provides loading indicators, progress bars, and animated text utilities
 */

export class LoadingIndicator {
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

export class ProgressBar {
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

export class AnimatedText {
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
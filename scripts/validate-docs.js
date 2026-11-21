#!/usr/bin/env node

/**
 * Documentation Validation Script
 * Validates markdown links and code snippets in documentation files
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

const PROJECT_ROOT = resolve(__dirname, '..');
const DOCS_DIR = join(PROJECT_ROOT, 'docs');
const MARKDOWN_EXTENSIONS = ['.md', '.mdx'];

// Configuration
const CONFIG = {
  // Patterns to ignore for link validation
  ignorePatterns: [
    /^https?:\/\/localhost/,
    /^https?:\/\/127\.0\.0\.1/,
    /^mailto:/,
    /^tel:/,
    /^#/, // anchor links
  ],
  // Allowed external domains that might be flaky but are acceptable
  allowedUnreachableDomains: [
    'discord.gg',
    'github.com/Kevin737866/stellar-liquidity-yield-engine/issues',
    'github.com/Kevin737866/stellar-liquidity-yield-engine/pull',
    'docs.rs',
    'conventionalcommits.org',
  ],
  // Code snippet validation
  requiredSnippetLangs: ['bash', 'sh', 'rust', 'typescript', 'ts', 'javascript', 'js', 'toml', 'yaml', 'json'],
  // Timeout for HTTP requests (ms)
  httpTimeout: 10000,
  // Max redirects
  maxRedirects: 5,
};

// Parse command line arguments
const args = process.argv.slice(2);
const SNIPPETS_ONLY = args.includes('--snippets-only');
const LINKS_ONLY = args.includes('--links-only');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logError(file, line, message) {
  console.error(`${colors.red}[ERROR]${colors.reset} ${file}:${line}: ${message}`);
}

function logWarning(file, line, message) {
  console.warn(`${colors.yellow}[WARN]${colors.reset} ${file}:${line}: ${message}`);
}

function logSuccess(message) {
  console.log(`${colors.green}[OK]${colors.reset} ${message}`);
}

function logInfo(message) {
  console.log(`${colors.blue}[INFO]${colors.reset} ${message}`);
}

// Find all markdown files
function findMarkdownFiles(dir, fileList = []) {
  const files = readdirSync(dir);
  
  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    
    if (stat.isDirectory()) {
      findMarkdownFiles(filePath, fileList);
    } else if (MARKDOWN_EXTENSIONS.includes(extname(file).toLowerCase())) {
      fileList.push(filePath);
    }
  }
  
  return fileList;
}

// Extract links from markdown content
function extractLinks(content, filePath) {
  const links = [];
  const seenUrls = new Set();
  
  // Regex for markdown links: [text](url "optional title")
  const linkRegex = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  // Regex for reference-style links: [text][ref] and [ref]: url
  const refLinkRegex = /^\[([^\]]+)\]:\s*(\S+)/gm;
  // Regex for bare URLs
  const bareUrlRegex = /(https?:\/\/[^\s\)]+)/g;
  
  let match;
  
  // Standard markdown links
  while ((match = linkRegex.exec(content)) !== null) {
    const beforeMatch = content.substring(0, match.index);
    const lineNumber = beforeMatch.split('\n').length;
    const url = match[2];
    const key = `${url}:${lineNumber}`;
    if (!seenUrls.has(key)) {
      seenUrls.add(key);
      links.push({
        type: 'markdown',
        text: match[1],
        url: url,
        line: lineNumber,
        raw: match[0],
      });
    }
  }
  
  // Reference-style links
  while ((match = refLinkRegex.exec(content)) !== null) {
    const beforeMatch = content.substring(0, match.index);
    const lineNumber = beforeMatch.split('\n').length;
    const url = match[2];
    const key = `${url}:${lineNumber}`;
    if (!seenUrls.has(key)) {
      seenUrls.add(key);
      links.push({
        type: 'reference',
        text: match[1],
        url: url,
        line: lineNumber,
        raw: match[0],
      });
    }
  }
  
  // Bare URLs (in code blocks these will be caught separately)
  const codeBlocks = extractCodeBlocks(content);
  let nonCodeContent = content;
  
  // Remove code blocks to avoid false positives
  for (const block of codeBlocks) {
    nonCodeContent = nonCodeContent.replace(block.raw, ' '.repeat(block.raw.length));
  }
  
  while ((match = bareUrlRegex.exec(nonCodeContent)) !== null) {
    const beforeMatch = nonCodeContent.substring(0, match.index);
    const lineNumber = beforeMatch.split('\n').length;
    const url = match[1];
    const key = `${url}:${lineNumber}`;
    if (!seenUrls.has(key)) {
      seenUrls.add(key);
      links.push({
        type: 'bare',
        text: url,
        url: url,
        line: lineNumber,
        raw: match[0],
      });
    }
  }
  
  return links;
}

// Extract code blocks from markdown
function extractCodeBlocks(content) {
  const blocks = [];
  const fenceRegex = /^```(\w*)\n([\s\S]*?)\n```/gm;
  const inlineCodeRegex = /`([^`\n]+)`/g;
  
  let match;
  
  // Fenced code blocks
  while ((match = fenceRegex.exec(content)) !== null) {
    const beforeMatch = content.substring(0, match.index);
    const lineNumber = beforeMatch.split('\n').length;
    blocks.push({
      lang: match[1].toLowerCase() || 'text',
      code: match[2],
      line: lineNumber,
      raw: match[0],
    });
  }
  
  // Inline code (for reference)
  while ((match = inlineCodeRegex.exec(content)) !== null) {
    const beforeMatch = content.substring(0, match.index);
    const lineNumber = beforeMatch.split('\n').length;
    blocks.push({
      lang: 'inline',
      code: match[1],
      line: lineNumber,
      raw: match[0],
    });
  }
  
  return blocks;
}

// Check if a URL should be ignored
function shouldIgnoreUrl(url) {
  for (const pattern of CONFIG.ignorePatterns) {
    if (pattern.test(url)) {
      return true;
    }
  }
  return false;
}

// Check if a URL is allowed to be unreachable
function isAllowedUnreachable(url) {
  for (const domain of CONFIG.allowedUnreachableDomains) {
    if (url.includes(domain)) {
      return true;
    }
  }
  return false;
}

// Validate a single URL
async function validateUrl(url, filePath, lineNumber) {
  if (shouldIgnoreUrl(url)) {
    return { valid: true, ignored: true };
  }
  
  // Check if it's a local file reference
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return validateLocalPath(url, filePath, lineNumber);
  }
  
  // External URL - make HTTP request
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.httpTimeout);
    
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok || response.status === 405 || response.status === 403) {
      // 405 (Method Not Allowed) and 403 (Forbidden) are OK for HEAD requests
      // Some servers don't support HEAD or block it but allow GET
      return { valid: true, status: response.status };
    }
    
    // Try GET if HEAD fails with 405
    if (response.status === 405) {
      const getResponse = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (getResponse.ok || getResponse.status === 403) {
        return { valid: true, status: getResponse.status };
      }
    }
    
    return { 
      valid: false, 
      status: response.status, 
      error: `HTTP ${response.status}: ${response.statusText}` 
    };
  } catch (error) {
    if (isAllowedUnreachable(url)) {
      return { valid: true, ignored: true, warning: `Unreachable but allowed: ${error.message}` };
    }
    if (error.name === 'AbortError') {
      return { valid: false, error: 'Request timeout' };
    }
    return { valid: false, error: error.message };
  }
}

// Validate local file path
function validateLocalPath(url, filePath, lineNumber) {
  // Handle anchor links
  if (url.startsWith('#')) {
    return { valid: true, type: 'anchor' };
  }
  
  // Handle relative paths
  const baseDir = resolve(filePath, '..');
  let targetPath;
  
  if (url.startsWith('/')) {
    // Absolute path from project root
    targetPath = join(PROJECT_ROOT, url.slice(1));
  } else {
    // Relative path
    targetPath = resolve(baseDir, url);
  }
  
  // Remove anchor fragment
  const [pathPart] = targetPath.split('#');
  
  try {
    const stat = statSync(pathPart);
    if (stat.isFile() || stat.isDirectory()) {
      return { valid: true, type: 'local', path: pathPart };
    }
  } catch {
    // File doesn't exist
  }
  
  return { 
    valid: false, 
    type: 'local', 
    path: pathPart, 
    error: 'File or directory not found' 
  };
}

// Validate code snippet
function validateCodeSnippet(block, filePath, lineNumber) {
  const issues = [];
  
  // Check if language is specified for fenced blocks
  if (block.lang !== 'inline' && block.lang !== 'text' && !block.lang) {
    issues.push({
      type: 'missing_language',
      line: lineNumber,
      message: 'Code block missing language specifier',
      severity: 'warning',
    });
  }
  
  // Check for common issues in code snippets
  const code = block.code.trim();
  
  if (!code) {
    issues.push({
      type: 'empty_code_block',
      line: lineNumber,
      message: 'Empty code block',
      severity: 'warning',
    });
  }
  
  // Check for placeholder patterns that suggest incomplete examples
  const placeholderPatterns = [
    /YOUR_[A-Z_]+/g,
    /<[A-Z_]+>/g,
    /\.\.\./g,  // Ellipsis as placeholder
    /TODO/gi,
    /FIXME/gi,
    /PLACEHOLDER/gi,
  ];
  
  for (const pattern of placeholderPatterns) {
    if (pattern.test(code)) {
      issues.push({
        type: 'placeholder',
        line: lineNumber,
        message: `Code snippet contains placeholder: ${pattern.source}`,
        severity: 'info',
      });
      break; // Only report once per block
    }
  }
  
  // Language-specific validation
  if (block.lang === 'bash' || block.lang === 'sh') {
    validateBashSnippet(code, lineNumber, issues);
  } else if (block.lang === 'rust') {
    validateRustSnippet(code, lineNumber, issues);
  } else if (block.lang === 'typescript' || block.lang === 'ts') {
    validateTypeScriptSnippet(code, lineNumber, issues);
  } else if (block.lang === 'javascript' || block.lang === 'js') {
    validateJavaScriptSnippet(code, lineNumber, issues);
  } else if (block.lang === 'toml') {
    validateTomlSnippet(code, lineNumber, issues);
  } else if (block.lang === 'json') {
    validateJsonSnippet(code, lineNumber, issues);
  }
  
  return issues;
}

// Validate bash snippets
function validateBashSnippet(code, lineNumber, issues) {
  const lines = code.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const actualLine = lineNumber + i;
    
    // Check for commands that require interaction
    if (line.includes('sudo') && !line.includes('echo') && !line.includes('#')) {
      issues.push({
        type: 'sudo_usage',
        line: actualLine,
        message: 'sudo usage in documentation snippet may require password',
        severity: 'info',
      });
    }
    
    // Check for incomplete commands (ending with \ but not continued)
    if (line.endsWith('\\') && i === lines.length - 1) {
      issues.push({
        type: 'incomplete_command',
        line: actualLine,
        message: 'Command ends with continuation but is last line',
        severity: 'warning',
      });
    }
    
    // Check for cd without following command
    if (line.startsWith('cd ') && i === lines.length - 1) {
      issues.push({
        type: 'cd_without_command',
        line: actualLine,
        message: 'cd command without subsequent command',
        severity: 'info',
      });
    }
  }
}

// Validate Rust snippets
function validateRustSnippet(code, lineNumber, issues) {
  // Basic syntax checks
  const openBraces = (code.match(/\{/g) || []).length;
  const closeBraces = (code.match(/\}/g) || []).length;
  
  if (openBraces !== closeBraces) {
    issues.push({
      type: 'unbalanced_braces',
      line: lineNumber,
      message: `Unbalanced braces: ${openBraces} open, ${closeBraces} close`,
      severity: 'warning',
    });
  }
  
  // Check for common Rust patterns that might be incomplete
  if (code.includes('fn main()') && !code.includes('}')) {
    issues.push({
      type: 'incomplete_main',
      line: lineNumber,
      message: 'Main function appears incomplete',
      severity: 'info',
    });
  }
}

// Validate TypeScript snippets
function validateTypeScriptSnippet(code, lineNumber, issues) {
  const openBraces = (code.match(/\{/g) || []).length;
  const closeBraces = (code.match(/\}/g) || []).length;
  
  if (openBraces !== closeBraces) {
    issues.push({
      type: 'unbalanced_braces',
      line: lineNumber,
      message: `Unbalanced braces: ${openBraces} open, ${closeBraces} close`,
      severity: 'warning',
    });
  }
  
  // Check for TypeScript-specific issues
  if (code.includes('import ') && !code.includes('from ')) {
    issues.push({
      type: 'incomplete_import',
      line: lineNumber,
      message: 'Import statement may be incomplete',
      severity: 'info',
    });
  }
}

// Validate JavaScript snippets
function validateJavaScriptSnippet(code, lineNumber, issues) {
  const openBraces = (code.match(/\{/g) || []).length;
  const closeBraces = (code.match(/\}/g) || []).length;
  
  if (openBraces !== closeBraces) {
    issues.push({
      type: 'unbalanced_braces',
      line: lineNumber,
      message: `Unbalanced braces: ${openBraces} open, ${closeBraces} close`,
      severity: 'warning',
    });
  }
}

// Validate TOML snippets
function validateTomlSnippet(code, lineNumber, issues) {
  try {
    // Basic TOML validation - check for balanced brackets and quotes
    const openBrackets = (code.match(/\[/g) || []).length;
    const closeBrackets = (code.match(/\]/g) || []).length;
    
    if (openBrackets !== closeBrackets) {
      issues.push({
        type: 'unbalanced_brackets',
        line: lineNumber,
        message: `Unbalanced brackets: ${openBrackets} open, ${closeBrackets} close`,
        severity: 'warning',
      });
    }
    
    // Check for unclosed quotes
    const doubleQuotes = (code.match(/"/g) || []).length;
    if (doubleQuotes % 2 !== 0) {
      issues.push({
        type: 'unclosed_quotes',
        line: lineNumber,
        message: 'Unclosed double quotes',
        severity: 'warning',
      });
    }
  } catch {
    issues.push({
      type: 'parse_error',
      line: lineNumber,
      message: 'TOML syntax error',
      severity: 'warning',
    });
  }
}

// Validate JSON snippets
function validateJsonSnippet(code, lineNumber, issues) {
  try {
    JSON.parse(code);
  } catch (error) {
    issues.push({
      type: 'json_parse_error',
      line: lineNumber,
      message: `Invalid JSON: ${error.message}`,
      severity: 'error',
    });
  }
}

// Main validation function
async function validateDocumentation() {
  log('🔍 Starting documentation validation...', 'cyan');
  
  if (SNIPPETS_ONLY) {
    logInfo('Running in snippets-only mode');
  } else if (LINKS_ONLY) {
    logInfo('Running in links-only mode');
  }
  
  // Find all markdown files
  const markdownFiles = [
    ...findMarkdownFiles(DOCS_DIR),
    join(PROJECT_ROOT, 'README.md'),
    join(PROJECT_ROOT, 'CONTRIBUTING.md'),
    join(PROJECT_ROOT, 'LICENSE'),
  ].filter(f => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
  
  logInfo(`Found ${markdownFiles.length} markdown files to validate`);
  
  let totalLinks = 0;
  let validLinks = 0;
  let brokenLinks = 0;
  let ignoredLinks = 0;
  let totalSnippets = 0;
  let snippetErrors = 0;
  let snippetWarnings = 0;
  
  const allErrors = [];
  const allWarnings = [];
  
  // Validate each file
  for (const filePath of markdownFiles) {
    const relativePath = relative(PROJECT_ROOT, filePath);
    logInfo(`Validating ${relativePath}...`);
    
    const content = readFileSync(filePath, 'utf-8');
    
    // Validate links (unless snippets-only)
    if (!SNIPPETS_ONLY) {
      const links = extractLinks(content, filePath);
      totalLinks += links.length;
      
      for (const link of links) {
        const result = await validateUrl(link.url, filePath, link.line);
        
        if (result.ignored) {
          ignoredLinks++;
          if (result.warning) {
            allWarnings.push({
              file: relativePath,
              line: link.line,
              message: result.warning,
              url: link.url,
            });
          }
        } else if (result.valid) {
          validLinks++;
        } else {
          brokenLinks++;
          allErrors.push({
            file: relativePath,
            line: link.line,
            message: `Broken link: ${link.url} - ${result.error}`,
            url: link.url,
            status: result.status,
          });
        }
      }
    }
    
    // Validate code snippets (unless links-only)
    if (!LINKS_ONLY) {
      const codeBlocks = extractCodeBlocks(content);
      totalSnippets += codeBlocks.length;
      
      for (const block of codeBlocks) {
        const issues = validateCodeSnippet(block, filePath, block.line);
        
        for (const issue of issues) {
          if (issue.severity === 'error') {
            snippetErrors++;
            allErrors.push({
              file: relativePath,
              line: issue.line,
              message: `Code snippet error: ${issue.message}`,
              type: issue.type,
            });
          } else if (issue.severity === 'warning') {
            snippetWarnings++;
            allWarnings.push({
              file: relativePath,
              line: issue.line,
              message: `Code snippet warning: ${issue.message}`,
              type: issue.type,
            });
          } else {
            allWarnings.push({
              file: relativePath,
              line: issue.line,
              message: `Code snippet info: ${issue.message}`,
              type: issue.type,
            });
          }
        }
      }
    }
  }
  
  // Print summary
  log('\n📊 Validation Summary', 'cyan');
  if (!SNIPPETS_ONLY) {
    log(`Links: ${validLinks} valid, ${brokenLinks} broken, ${ignoredLinks} ignored (${totalLinks} total)`);
  }
  if (!LINKS_ONLY) {
    log(`Code Snippets: ${totalSnippets} total, ${snippetErrors} errors, ${snippetWarnings} warnings`);
  }
  
  // Print errors
  if (allErrors.length > 0) {
    log('\n❌ Errors:', 'red');
    for (const error of allErrors) {
      logError(error.file, error.line, error.message);
    }
  }
  
  // Print warnings
  if (allWarnings.length > 0) {
    log('\n⚠️  Warnings:', 'yellow');
    for (const warning of allWarnings) {
      logWarning(warning.file, warning.line, warning.message);
    }
  }
  
  // Exit with error code if there are errors
  if (allErrors.length > 0) {
    log(`\n❌ Validation failed with ${allErrors.length} error(s)`, 'red');
    process.exit(1);
  }
  
  if (allWarnings.length > 0) {
    log(`\n⚠️  Validation passed with ${allWarnings.length} warning(s)`, 'yellow');
  } else {
    log('\n✅ All validation checks passed!', 'green');
  }
  
  process.exit(0);
}

// Run validation
validateDocumentation().catch(error => {
  logError('validation', 0, `Unexpected error: ${error.message}`);
  process.exit(1);
});
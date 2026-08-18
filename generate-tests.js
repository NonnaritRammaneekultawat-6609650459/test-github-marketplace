const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const core = require('@actions/core');
const github = require('@actions/github');
const promptTemplate = require('./prompt-template');
require('dotenv').config();

// Configuration
const GEMINI_API_KEY = core.getInput('gemini_api_key') || process.env.GEMINI_API_KEY;
const SONAR_TOKEN = core.getInput('sonar_token') || process.env.SONAR_TOKEN;
const GITHUB_TOKEN = core.getInput('github_token') || process.env.GITHUB_TOKEN;
const MODEL_NAME = 'gemini-3.1-flash-lite';
const TEST_DIR = 'Test';
const TEST_FILE = path.join(TEST_DIR, 'generated.test.js');
const AUDIT_RESOLVE_FILE = 'audit-resolve.json';
const CONFIG_FILE = 'config_cov.json';

function getQualityGateConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn(`Warning: Could not read ${CONFIG_FILE}. Using defaults.`);
  }
  return {};
}
const qgConfig = getQualityGateConfig();

if (!GEMINI_API_KEY) {
  core.setFailed('Error: GEMINI_API_KEY is not set.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

/**
 * Helper function to call Gemini API with exponential backoff retry logic.
 */
async function callGeminiWithRetry(apiFn, maxRetries = 5, initialDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await apiFn();
    } catch (err) {
      lastError = err;
      const isRateLimit = err.message?.includes('429') || err.message?.toLowerCase().includes('quota');
      const isTransient = err.message?.includes('500') || err.message?.includes('503') || err.message?.includes('fetch failed');
      
      if (isRateLimit || isTransient || attempt < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 1000;
        console.warn(`  ! API call failed (Attempt ${attempt + 1}/${maxRetries}): ${err.message}. Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Executes a command safely using spawnSync to avoid shell injection and security hotspots.
 */
function safeExec(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env },
    ...options
  });
  
  if (result.error) {
    throw result.error;
  }
  
  return result;
}

async function fetchSonarCloudResults() {
  console.log('\n--- Fetching SonarCloud Results ---');
  const sonarReport = {
    passed: false,
    metrics: {
      bugs: 'N/A',
      vulnerabilities: 'N/A',
      code_smells: 'N/A',
      security_hotspots: 'N/A'
    },
    issues: []
  };

  if (!SONAR_TOKEN) {
    console.warn('Warning: SONAR_TOKEN is not set. Skipping SonarCloud fetch.');
    return sonarReport;
  }

  try {
    const sonarProps = fs.readFileSync('sonar-project.properties', 'utf8');
    const projectKeyMatch = sonarProps.match(/sonar.projectKey=(.+)/);
    if (!projectKeyMatch) {
      console.error('Error: sonar.projectKey not found in sonar-project.properties');
      return sonarReport;
    }
    const projectKey = projectKeyMatch[1].trim();

    let prNumber = null;
    if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_EVENT_PATH) {
      const eventData = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      prNumber = eventData.pull_request?.number;
    }

    const authHeader = `Basic ${Buffer.from(SONAR_TOKEN + ':').toString('base64')}`;
    const prParam = prNumber ? `&pullRequest=${prNumber}` : '';
    const statusUrl = `https://sonarcloud.io/api/qualitygates/project_status?projectKey=${projectKey}${prParam}`;

    // Smart Polling Mechanism
    let attempts = 0;
    const maxAttempts = 15; // Max 75 seconds (15 * 5s)
    let isPending = true;

    console.log('Polling SonarCloud for analysis results (waiting for processing)...');

    while (isPending && attempts < maxAttempts) {
      attempts++;
      console.log(`  Attempt ${attempts}/${maxAttempts}: Checking Quality Gate status...`);
      
      try {
        const response = await fetch(statusUrl, { headers: { 'Authorization': authHeader } });
        if (response.ok) {
          const data = await response.json();
          // Status 'NONE' means SonarCloud is still processing the background task
          if (data.projectStatus && data.projectStatus.status !== 'NONE') {
            sonarReport.passed = data.projectStatus.status === 'OK';
            console.log(`SonarCloud Status Ready: ${data.projectStatus.status}`);
            isPending = false;
            break;
          } else {
            console.log(`  > SonarCloud is still calculating... (Status: ${data.projectStatus?.status || 'NONE'})`);
          }
        }
      } catch (e) {
        console.warn(`  ! Polling attempt ${attempts} failed: ${e.message}`);
      }
      
      if (isPending) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    if (isPending) {
      console.warn('Warning: SonarCloud status is still pending or unreachable after polling.');
    }

    // Metrics Fetch
    const metricsUrl = `https://sonarcloud.io/api/measures/component?component=${projectKey}${prParam}&metricKeys=bugs,vulnerabilities,code_smells,security_hotspots`;
    const metricsResponse = await fetch(metricsUrl, { headers: { 'Authorization': authHeader } });
    if (metricsResponse.ok) {
      const metricsData = await metricsResponse.json();
      if (metricsData.component?.measures) {
        metricsData.component.measures.forEach(m => {
          if (m.metric === 'bugs') sonarReport.metrics.bugs = m.value;
          if (m.metric === 'vulnerabilities') sonarReport.metrics.vulnerabilities = m.value;
          if (m.metric === 'code_smells') sonarReport.metrics.code_smells = m.value;
          if (m.metric === 'security_hotspots') sonarReport.metrics.security_hotspots = m.value;
        });
      }
    }

    // Issues Fetch (If not passed)
    if (!sonarReport.passed) {
      const issuesUrl = `https://sonarcloud.io/api/issues/search?componentKeys=${projectKey}${prParam}&resolved=false&ps=10`;
      const issuesResponse = await fetch(issuesUrl, { headers: { 'Authorization': authHeader } });
      if (issuesResponse.ok) {
        const issuesData = await issuesResponse.json();
        sonarReport.issues = issuesData.issues || [];
      }
    }

    return sonarReport;
  } catch (error) {
    console.error('Error: SonarCloud fetch failed.', error.message);
    return sonarReport;
  }
}

async function analyzeSonarFailure(sonarReport) {
  if (!sonarReport.issues || sonarReport.issues.length === 0) return null;

  console.log('Analyzing SonarCloud issues with Gemini...');
  try {
    const issuesText = sonarReport.issues.map(i => `- [${i.severity}] ${i.message} (File: ${i.component}, Line: ${i.line})`).join('\n');
    const analysisPrompt = `
      As a Senior Security Engineer and Code Reviewer, analyze the following issues reported by SonarCloud and provide clear remediation advice and code examples in English.
      
      SonarCloud Issues:
      ${issuesText}

      Please prioritize security and critical bugs.
    `;
    
    const result = await callGeminiWithRetry(() => model.generateContent(analysisPrompt));
    const response = await result.response;
    return response.text();
  } catch (err) {
    console.error('Error: Sonar analysis failed.', err.message);
    return null;
  }
}

function getModifiedFiles() {
  console.log('--- Finding modified files ---');
  try {
    // Compare current branch against origin/main (GitHub main)
    console.log('Checking: git diff origin/main...HEAD');
    
    // Check all files inside src/ to prevent missing nested files
    const result = safeExec('git', ['diff', 'origin/main...HEAD', '--name-only', '--', 'src/']);
    
    if (result.status !== 0) {
      console.warn('Warning: Git diff command failed. Make sure origin/main exists (e.g., fetch origin main).');
      if (result.stderr) console.warn('Git stderr:', result.stderr.trim());
      return [];
    }
    
    // Filter only .js files
    const files = result.stdout.split('\n')
      .map(file => file.trim())
      .filter(file => file.endsWith('.js'));
      
    return files;
  } catch (error) {
    console.warn('Warning: Git diff check encountered an issue:', error.message);
    return [];
  }
}

/**
 * Finds files that depend on the modified files (Static Analysis)
 */
function getRelatedFiles(modifiedFiles) {
  console.log('--- Analyzing dependencies for modified files ---');
  const relatedFiles = new Set(modifiedFiles);
  const allSrcFiles = [];

  // 1. Get all JS files in src directory
  const getAllJsFiles = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        getAllJsFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        allSrcFiles.push(fullPath.replaceAll('\\', '/'));
      }
    }
  };

  if (fs.existsSync('src')) {
    getAllJsFiles('src');
  }

  // 2. For each file, check if it imports any of the modified files
  // This is a simplified static analysis looking for 'require' or 'import'
  for (const file of allSrcFiles) {
    if (relatedFiles.has(file)) continue;

    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const modifiedFile of modifiedFiles) {
        const fileName = path.basename(modifiedFile, '.js');
        
        // Match require('./path/to/file') or import ... from './path/to/file'
        // This handles various import styles and pathing
        const dependencyPattern = new RegExp(`(require\\s*\\(|from\\s+['"]|import\\s+['"]).*\\/${fileName}['"]`, 'g');
        
        if (dependencyPattern.test(content)) {
          console.log(`  > ${file} depends on ${modifiedFile}. Adding to test list.`);
          relatedFiles.add(file);
          break; 
        }
      }
    } catch (err) {
      console.warn(`  ! Could not read ${file} for dependency analysis.`);
    }
  }

  return Array.from(relatedFiles);
}

function runNpmAudit() {
  console.log('\n--- Running NPM Audit ---');
  let auditData;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  
  const result = safeExec(npmCmd, ['audit', '--json'], { shell: true });
  const output = result.stdout || result.stderr;

  const auditReport = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    isSecure: true,
    details: []
  };

  try {
    auditData = JSON.parse(output);
  } catch (parseError) {
    console.error('Error: Failed to parse npm audit output as JSON.', parseError.message);
    return auditReport;
  }

  if (auditData?.vulnerabilities) {
    try {
      const auditResolveContent = fs.existsSync(AUDIT_RESOLVE_FILE) ? fs.readFileSync(AUDIT_RESOLVE_FILE, 'utf8') : '{"decisions":[]}';
      const auditResolve = JSON.parse(auditResolveContent);
      const ignoredIds = new Set(auditResolve.decisions.map(d => d.id));
      
      Object.values(auditData.vulnerabilities).forEach(v => {
        if (ignoredIds.has(v.id)) return;

        if (v.severity === 'critical') auditReport.critical++;
        else if (v.severity === 'high') auditReport.high++;
        else if (v.severity === 'moderate') auditReport.moderate++;
        else if (v.severity === 'low') auditReport.low++;
        
        auditReport.details.push(`${v.name} (${v.severity})`);
      });

      // Overall security status: Vulnerable if there are ANY unignored high or critical vulnerabilities
      if (auditReport.critical > 0 || auditReport.high > 0) {
        auditReport.isSecure = false;
      }
    } catch (resolveError) {
      console.error('Error: Failed to process audit exceptions.', resolveError.message);
    }
  }

  return auditReport;
}

/**
 * Reads specification context for a given file.
 * Looks for <filename>.spec.md in the same directory, or spec.md / project-spec.md in the root.
 */
function getSpecContent(sourceFile) {
  let specContext = '';
  try {
    // 1. Check for file-level spec: e.g., src/math.spec.md
    const dir = path.dirname(sourceFile);
    const ext = path.extname(sourceFile);
    const basename = path.basename(sourceFile, ext);
    const fileSpecPath = path.join(dir, `${basename}.spec.md`);
    
    if (fs.existsSync(fileSpecPath)) {
      specContext += `\n--- File Specification (${basename}.spec.md) ---\n${fs.readFileSync(fileSpecPath, 'utf8')}\n`;
    }

    // 2. Check for global specs
    if (fs.existsSync('spec.md')) {
      specContext += `\n--- Global Specification (spec.md) ---\n${fs.readFileSync('spec.md', 'utf8')}\n`;
    } else if (fs.existsSync('project-spec.md')) {
      specContext += `\n--- Global Specification (project-spec.md) ---\n${fs.readFileSync('project-spec.md', 'utf8')}\n`;
    }
  } catch (err) {
    console.warn(`Warning: Could not read spec files for ${sourceFile}:`, err.message);
  }
  return specContext.trim();
}

async function classifyFileWithGemini(file, code) {
  console.log(`\n--- AI Auditing & Classifying: ${file} ---`);
  try {
    const specContext = getSpecContent(file);
    const specInstruction = specContext ? `\n      Specifications to follow:\n      ${specContext}\n` : '';

    const prompt = `
      As a Senior Software Architect and Security Auditor, analyze the following JavaScript code.
      1. Classify its importance and coverage needs.
      2. Audit the logic for bugs, unintended behavior, or security risks.
      
      Return ONLY a JSON object with the following structure:
      {
        "importance": "critical" | "high" | "medium" | "low",
        "min_coverage_threshold": number,
        "focus_areas": ["security", "logic", "performance", "api"],
        "description": "one sentence explaining purpose",
        "review": {
          "status": "clean" | "suspicious" | "buggy",
          "findings": "Brief explanation of any logic errors or improvements needed. If clean, say 'No issues identified'.",
          "remediation": "Provide a small code snippet or instruction to fix the issue if found."
        }
      }

      Context:
      - Look for math errors (e.g. using + instead of *).
      - Look for security risks (e.g. hardcoded secrets, dangerous functions).
      - Check if parameters are handled correctly.${specInstruction}

      File: ${file}
      Code:
      ${code}
    `;

    const result = await callGeminiWithRetry(() => model.generateContent(prompt));
    const response = await result.response;
    let text = response.text().trim();
    
    if (text.startsWith('```json')) {
      text = text.replace(/```json|```/g, '').trim();
    } else if (text.startsWith('```')) {
      text = text.replace(/```/g, '').trim();
    }
    
    return JSON.parse(text);
  } catch (err) {
    console.error(`  ! Audit failed for ${file}:`, err.message);
    return {
      importance: "medium", min_coverage_threshold: 80, focus_areas: ["logic"], description: "Default classification.",
      review: { status: "clean", findings: "Audit failed due to technical error.", remediation: "" }
    };
  }
}

async function generateTestForFile(file, promptTemplate, classification) {
  console.log(`\n--- Generating tests for ${file} ---`);
  try {
    const code = fs.readFileSync(file, 'utf8');
    
    const absoluteSourcePath = path.resolve(file);
    const absoluteTestDirPath = path.resolve(TEST_DIR);
    let relativePath = path.relative(absoluteTestDirPath, absoluteSourcePath);
    
    if (!relativePath.startsWith('.')) {
      relativePath = './' + relativePath;
    }
    relativePath = relativePath.replaceAll('\\', '/');

    const specContext = getSpecContent(file);
    const targetCoverage = classification.targetCoverage || 80;

    const prompt = promptTemplate
      .replaceAll('{{source_file}}', file)
      .replaceAll('{{relative_path}}', relativePath)
      .replaceAll('{{code}}', code)
      .replace('{{classification}}', JSON.stringify(classification, null, 2))
      .replace('{{spec_context}}', specContext)
      .replace('{{target_coverage}}', targetCoverage);

    const result = await callGeminiWithRetry(() => model.generateContent(prompt));
    const response = await result.response;
    let text = response.text();
    
    return text.replaceAll('```javascript', '').replaceAll('```', '').trim();
  } catch (genError) {
    console.error(`Error: Failed to generate test for ${file}.`, genError.message);
    return `// Failed to generate tests for ${file}: ${genError.message}`;
  }
}

async function analyzeJestFailure(jestOutput, modifiedFiles) {
  console.error('Analyzing Jest errors with Gemini...');
  try {
    // Read the generated test files to provide context
    let allTestContent = '';
    for (const file of modifiedFiles) {
      const fileName = path.basename(file, '.js');
      const testFile = path.join(TEST_DIR, `${fileName}.test.js`);
      if (fs.existsSync(testFile)) {
        allTestContent += `\n--- Content of ${testFile} ---\n${fs.readFileSync(testFile, 'utf8')}\n`;
      }
    }

    const analysisPrompt = `The following Jest unit tests failed. Analyze the error logs and provide a concise explanation of the cause and a suggested fix in English.\n\nError Logs:\n${jestOutput}\n\nGenerated Test Code Context:${allTestContent}`;
    
    const analysisResult = await callGeminiWithRetry(() => model.generateContent(analysisPrompt));
    const analysisResponse = await analysisResult.response;
    console.log('\n--- Gemini Error Analysis ---');
    const analysisText = analysisResponse.text();
    console.log(analysisText);
    return analysisText;
  } catch (analysisError) {
    console.error('Error: Gemini analysis failed.', analysisError.message);
    return `Analysis failed: ${analysisError.message}`;
  }
}

function generateMarkdownReport(summary) {
  const statusEmoji = (success) => success ? '✅' : '❌';
  const sonarEmoji = summary.sonar?.passed ? '✅' : '❌';

  const classificationTable = summary.classifications ? `
### 🤖 AI Code Classification & Status
| File | Importance | Target % | Actual % | Status |
| :--- | :--- | :--- | :--- | :--- |
${summary.modifiedFiles.map(f => {
    const c = summary.classifications[f];
    const s = summary.fileStatus[f] || { actual: 0, required: 0, pass: false };
    const targetCov = c?.targetCoverage || c?.min_coverage_threshold || 0;
    return `| \`${f}\` | **${c?.importance.toUpperCase()}** | ${targetCov}% | ${s.actual}% | ${statusEmoji(s.pass)} |`;
  }).join('\n')}
` : '';

  const aiReviewSection = `
### 🕵️ AI Proactive Code Review
${summary.modifiedFiles.map(f => {
    const c = summary.classifications[f];
    if (!c || !c.review) return '';
    const reviewEmoji = c.review.status === 'buggy' ? '🔴' : (c.review.status === 'suspicious' ? '🟡' : '🟢');
    return `
#### 📄 File: \`${f}\`
- **Audit Status:** ${reviewEmoji} **${c.review.status.toUpperCase()}**
- **Analysis:** ${c.review.findings}
${c.review.remediation ? `\n> **💡 Suggested Fix:**\n> \`\`\`javascript\n> ${c.review.remediation.split('\n').join('\n> ')}\n> \`\`\`` : ''}
`;
  }).join('\n---\n')}
`;

  const sonarAnalysisSection = summary.sonarAnalysis ? `
---
### 🔍 AI SonarCloud Remediation
${summary.sonarAnalysis}
` : '';

  const actionUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const actionLink = actionUrl ? `\n\n--- \n[ 🛠️ View Detailed Action Run ](${actionUrl})` : '';

  return `
# 🚀 AI-Powered Quality Gate Report

### 📊 Overall Result: ${statusEmoji(summary.success)} ${summary.success ? 'PASS' : 'FAIL'}

---
${classificationTable}

---
${aiReviewSection}

---

### 🛡️ Security & Audit
- **NPM Audit:** ${statusEmoji(summary.audit.isSecure)} ${summary.audit.isSecure ? 'SECURE' : 'VULNERABLE'}
- **Vulnerabilities:** [Critical: ${summary.audit.critical}, High: ${summary.audit.high}, Moderate: ${summary.audit.moderate}, Low: ${summary.audit.low}]

---

### 📡 SonarCloud Status
- **Quality Gate:** ${sonarEmoji} ${summary.sonar?.passed ? 'PASSED' : 'FAILED'}
- **Metrics:** [Bugs: ${summary.sonar?.metrics?.bugs || 0}, Vulns: ${summary.sonar?.metrics?.vulnerabilities || 0}, Smells: ${summary.sonar?.metrics?.code_smells || 0}]

${sonarAnalysisSection}

---

### 🤖 Automation Details
- **Tests Generated:** ${summary.testsGenerated}
- **Modified Files:** ${summary.modifiedFiles.map(f => `\`${f}\``).join(', ')}

${summary.analysis ? `\n--- \n### 🔍 AI Test Failure Analysis\n${summary.analysis}\n` : ''}${actionLink}

---
*Generated by Automated Quality Gate with Gemini 3.1 Flash Lite*
  `.trim();
}

async function postPRComment(markdownBody) {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    console.log('Not a pull request. Skipping PR comment.');
    return;
  }

  if (!GITHUB_TOKEN) {
    console.warn('Warning: GITHUB_TOKEN is not set. Cannot post PR comment.');
    return;
  }

  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    const prNumber = eventData.pull_request.number;
    const repoFullName = eventData.repository.full_name;

    console.log(`Posting comment to PR #${prNumber} in ${repoFullName}...`);

    const response = await fetch(`https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body: markdownBody })
    });

    if (response.ok) {
      console.log('Successfully posted PR comment.');
    } else {
      const errorText = await response.text();
      console.error(`Error: Failed to post PR comment (${response.status}): ${errorText}`);
    }
  } catch (error) {
    console.error('Error: Failed to post PR comment.', error.message);
  }
}

async function run() {
  const STATE_FILE = '.gate-state.json';
  let summary = {
    modifiedFiles: [],
    classifications: {},
    audit: null,
    testsGenerated: 0,
    jestPassed: false,
    coverage: {
      statements: 0,
      branches: 0,
      functions: 0,
      lines: 0,
      required: 80,
      status: 'FAIL'
    },
    sonar: null,
    analysis: null,
    success: false,
    startTime: Date.now()
  };

  const mode = process.argv.includes('--report') ? 'report' : (process.argv.includes('--prepare') ? 'prepare' : 'all');

  try {
    if (mode === 'report') {
      if (fs.existsSync(STATE_FILE)) {
        console.log('--- Loading state for reporting ---');
        summary = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        
        if (summary.skipped) {
          console.log('No modified files were found. Skipping full report.');
          // Generate a simple report for skipped status
          const skipReport = `
# 🚀 AI-Powered Quality Gate Report

### 📊 Overall Result: ✅ PASS (Skipped)

---
No JavaScript files in \`src/\` were modified in this PR. Quality Gate checks were skipped.

---
*Generated by Automated Quality Gate with Gemini 3.1 Flash Lite*
          `.trim();
          await postPRComment(skipReport);
          return;
        }
      } else {
        console.error('Error: State file not found. Run with --prepare first.');
        process.exit(1);
      }
    } else {
      let modifiedFiles = [];
      const targetFile = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

      if (targetFile) {
        if (fs.existsSync(targetFile)) {
          console.log(`--- Using targeted file: ${targetFile} ---`);
          modifiedFiles = [targetFile];
        } else {
          console.error(`Error: Targeted file ${targetFile} not found.`);
          process.exit(1);
        }
      } else {
        const directModifiedFiles = getModifiedFiles();
        if (directModifiedFiles.length === 0) {
          console.log('No modified files found in src/. Saving skipped state.');
          summary.skipped = true;
          summary.success = true;
          fs.writeFileSync(STATE_FILE, JSON.stringify(summary, null, 2));
          return;
        }

        // Expand list to include files that depend on the modified ones
        modifiedFiles = getRelatedFiles(directModifiedFiles);
      }
      
      summary.modifiedFiles = modifiedFiles;
      console.log(`Files to process (Modified + Related): ${modifiedFiles.join(', ')}`);

      summary.audit = runNpmAudit();

      // 1. Clean and prepare Test directory
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
      fs.mkdirSync(TEST_DIR);

      let testsGeneratedCount = 0;
      let totalThreshold = 0;

      for (const file of modifiedFiles) {
        const code = fs.readFileSync(file, 'utf8');
        
        // AI Step: Classify the file importance and threshold
        const classification = await classifyFileWithGemini(file, code);
        
        // Calculate Target Coverage
        const normalizedFileKey = file.replaceAll('\\', '/');
        classification.targetCoverage = qgConfig?.files?.[normalizedFileKey]
                                     || qgConfig?.global
                                     || classification.min_coverage_threshold
                                     || 80;

        summary.classifications[file] = classification;
        totalThreshold += classification.targetCoverage;

        // AI Step: Generate tests with classification context
        const testCode = await generateTestForFile(file, promptTemplate, classification);
        
        const fileName = path.basename(file, '.js');
        const individualTestFile = path.join(TEST_DIR, `${fileName}.test.js`);
        
        fs.writeFileSync(individualTestFile, testCode);
        console.log(`Tests for ${file} written to ${individualTestFile}`);
        
        // Extract test descriptions for GitHub Actions visibility
        const testCases = testCode.match(/test\(['"](.*)['"]/g) || testCode.match(/it\(['"](.*)['"]/g) || [];
        const formattedTestCases = testCases.map(t => "  - " + t.replace(/test\(|it\(|['"]/g, '')).join('\n');

        console.log(`\n::group::🤖 AI Generated Tests for ${file}`);
        console.log(`Summary of test cases:`);
        console.log(formattedTestCases || "  - (No test cases identified)");
        console.log(`\n--- Full Generated Code ---\n`);
        console.log(testCode);
        console.log('::endgroup::\n');

        testsGeneratedCount++;
      }
      summary.testsGenerated = testsGeneratedCount;
      summary.coverage.required = Math.round(totalThreshold / modifiedFiles.length) || 80;

      console.log('\n--- Running Jest ---');
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      const jestResult = spawnSync(npxCmd, ['jest', '--coverage', '--coverageReporters=text-summary', '--coverageReporters=json-summary', '--coverageReporters=lcov'], { 
        encoding: 'utf8',
        shell: true 
      });
      
      console.log(jestResult.stdout);
      console.error(jestResult.stderr);

      // Parse Per-File Coverage from JSON
      let fileCoverageData = {};
      const summaryJsonPath = path.join('coverage', 'coverage-summary.json');
      if (fs.existsSync(summaryJsonPath)) {
        try {
          const rawData = fs.readFileSync(summaryJsonPath, 'utf8');
          fileCoverageData = JSON.parse(rawData);
        } catch (e) {
          console.warn('Warning: Could not parse coverage-summary.json');
        }
      }
      summary.fileCoverage = fileCoverageData;

      if (jestResult.status === 0) {
        console.log('Tests passed successfully!');
        summary.jestPassed = true;
      } else {
        const jestOutput = jestResult.stderr || jestResult.stdout;
        summary.analysis = await analyzeJestFailure(jestOutput, modifiedFiles);
        summary.jestPassed = false;
      }

      const coverageOutput = jestResult.stdout;
      const extractCoverage = (label) => {
        const regex = new RegExp(`${label}\\s+:\\s+(\\d+\\.?\\d*)%`);
        const match = coverageOutput.match(regex);
        return match ? parseFloat(match[1]) : 0;
      };

      summary.coverage.statements = extractCoverage('Statements');
      summary.coverage.branches = extractCoverage('Branches');
      summary.coverage.functions = extractCoverage('Functions');
      summary.coverage.lines = extractCoverage('Lines');

      // NEW: Per-File Coverage Validation
      let allFilesMetAiThreshold = true;
      summary.fileStatus = {};

      Object.keys(summary.fileCoverage).forEach(filePath => {
        if (filePath === 'total') return;
        const relPath = path.relative(process.cwd(), filePath).replaceAll('\\', '/');
        const classification = summary.classifications[relPath] || summary.classifications[filePath];
        
        if (classification) {
          const actual = summary.fileCoverage[filePath].statements.pct;
          const required = classification.targetCoverage || classification.min_coverage_threshold || 80;
          const met = actual >= required;
          summary.fileStatus[relPath] = { actual, required, pass: met };
          if (!met) allFilesMetAiThreshold = false;
        }
      });
      summary.coverageMet = allFilesMetAiThreshold;

      if (mode === 'prepare') {
        console.log('--- Saving state and exiting prepare mode ---');
        fs.writeFileSync(STATE_FILE, JSON.stringify(summary, null, 2));
        
        // BLOCKING: Exit with error if any local checks failed
        const prepareSuccess = summary.jestPassed && summary.coverageMet && summary.audit.isSecure;
        if (!prepareSuccess) {
          console.error('--- Quality Gate (Prepare) FAILED ---');
          process.exit(1);
        }
        return;
      }
    }

    // --- Report / Fetch Stage ---
    summary.sonar = await fetchSonarCloudResults();

    // AI Step: Analyze Sonar failures if any
    if (!summary.sonar.passed && summary.sonar.issues.length > 0) {
      summary.sonarAnalysis = await analyzeSonarFailure(summary.sonar);
    }

    summary.success = summary.jestPassed && 
                      summary.coverageMet && 
                      summary.audit.isSecure && 
                      (summary.sonar?.passed !== false);

    // Final Summary Report
    const duration = ((Date.now() - summary.startTime) / 1000).toFixed(2);
    const actionUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;

    console.log('\n' + '='.repeat(60));
    console.log('                 AUTOMATED QUALITY GATE REPORT');
    console.log('='.repeat(60));
    
    if (actionUrl) {
      console.log(`\n[ 🛠️ ACTION RUN URL ]: ${actionUrl}`);
    }

    console.log('\n[ 1. TEST COVERAGE REPORT ]');
    console.log(`- Aggregate Statement Coverage: ${summary.coverage.statements}%`);
    console.log(`- Overall Target (AI Avg):     ${summary.coverage.required}%`);
    console.log(`- Coverage Status (AI Match):  ${summary.coverageMet ? 'PASS' : 'FAIL'}`);

    console.log('\n--- Per-File AI Quality Gate ---');
    Object.keys(summary.fileStatus || {}).forEach(file => {
      const s = summary.fileStatus[file];
      const status = s.pass ? '[PASS]' : '[FAIL]';
      console.log(`${status} ${file}: Actual ${s.actual}% | AI Target: ${s.required}%`);
    });

    console.log('\n[ 2. SECURITY & AUDIT REPORT ]');
    console.log(`- Vulnerabilities Found:`);
    console.log(`    * Critical: ${summary.audit.critical}`);
    console.log(`    * High:     ${summary.audit.high}`);
    console.log(`    * Moderate: ${summary.audit.moderate}`);
    console.log(`    * Low:      ${summary.audit.low}`);
    console.log(`- Security Status:      ${summary.audit.isSecure ? 'SECURE' : 'VULNERABLE'}`);

    console.log('\n[ 3. AI GENERATION & DIFF HISTORY ]');
    console.log(`- Modified Files:`);
    summary.modifiedFiles.forEach(file => console.log(`    * ${file}`));
    console.log(`- AI Tests Created:   ${summary.testsGenerated}`);

    console.log('\n[ 4. OVERALL SYSTEM STATUS ]');
    console.log(`- Jest Execution:     ${summary.jestPassed ? 'PASSED' : 'FAILED'}`);
    console.log(`- Sonar Status:       ${summary.sonar?.passed ? 'PASSED' : 'FAILED'}`);

    if (summary.sonarAnalysis) {
      console.log('\n--- Gemini Sonar Analysis ---');
      console.log(summary.sonarAnalysis);
    }

    console.log(`- FINAL STATUS:       ${summary.success ? 'PASS' : 'FAIL'}`);
    console.log(`- Total Duration:     ${duration}s`);
    console.log('\n' + '='.repeat(60) + '\n');

    // Generate and post PR Comment
    const markdownReport = generateMarkdownReport(summary);
    await postPRComment(markdownReport);

    if (!summary.success) {
      process.exit(1);
    }

  } catch (error) {
    core.setFailed(`Workflow failed: ${error.message}`);
    process.exit(1);
  }
}

run();
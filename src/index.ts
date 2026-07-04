#!/usr/bin/env bun
import { write } from "bun";
import boxen from "boxen";
import chalk from "chalk";
import { unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";
import ora, { type Ora } from "ora";

interface Subtitle {
  timestamp: string;
  speaker: string;
  dialogue: string;
}

interface VideoMetadata {
  title: string;
  duration: number;
}

interface YouTubeComment {
  author?: string;
  author_id?: string;
  author_url?: string;
  text?: string;
  is_pinned?: boolean;
}

type PromptReader = AsyncIterableIterator<string>;

interface Keypress {
  ctrl?: boolean;
  name?: string;
}

class CliCancelledError extends Error {
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "CliCancelledError";
  }
}

let activeSpinner: Ora | null = null;
let cancelActiveSubprocess: (() => void) | null = null;
let cliCancelled = false;
let cleanupFilePaths = new Set<string>();

const COMMENT_AUTHOR_CANDIDATES = [
  "KakoeiSbi",
  "@KakoeiSbi",
  "https://www.youtube.com/@KakoeiSbi",
  "https://youtube.com/@KakoeiSbi",
];

const SUBTITLE_LINE_PATTERN =
  /^\s*\(?[0-9]+(?::[0-9]{1,2}){1,2}\)?\s*[^:]+:\s*["“]?.+["”]?\s*$/u;

const CREDIT_DIALOGUE = "Subtitle translation credits: @KakoeiSbi";
const MAX_DIALOGUE_CHARS = 84;
const AUTO_CHUNK_GAP_SECONDS = 0.12;

function isCliCancelledError(error: unknown): error is CliCancelledError {
  return error instanceof CliCancelledError;
}

async function cleanupFiles(filePaths: Iterable<string>): Promise<void> {
  await Promise.all(
    [...filePaths].map(async (filePath) => {
      try {
        await unlink(filePath);
      } catch {
        // Ignore missing or already-cleaned files.
      }
    })
  );
}

export function parseTimestamp(timestamp: string): number {
  const parts = timestamp
    .trim()
    .split(":")
    .map((part) => Number.parseInt(part, 10));

  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => Number.isNaN(part))
  ) {
    return Number.NaN;
  }

  if (parts.length === 2) {
    const [minutes = 0, seconds = 0] = parts;
    if (seconds >= 60) {
      return Number.NaN;
    }

    return minutes * 60 + seconds;
  }

  const [hours = 0, minutes = 0, seconds = 0] = parts;
  if (minutes >= 60 || seconds >= 60) {
    return Number.NaN;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

export function formatSRTTimestamp(seconds: number): string {
  const safeSeconds = Math.max(seconds, 0);
  const pad = (num: number): string => num.toString().padStart(2, "0");
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = Math.floor(safeSeconds % 60);
  const wholeSeconds = Math.floor(safeSeconds);
  const ms = Math.floor((safeSeconds - wholeSeconds) * 1000);

  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${ms
    .toString()
    .padStart(3, "0")}`;
}

export function formatDurationLabel(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const pad = (num: number): string => num.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`;
  }

  return `${minutes}:${pad(secs)}`;
}

export function splitLongDialogue(dialogue: string, maxChars = MAX_DIALOGUE_CHARS): string[] {
  const normalized = dialogue.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const sentenceParts =
    normalized.match(/[^.!?]+[.!?]*|[^.!?]+$/g)?.map((part) => part.trim()) ?? [normalized];
  const chunks: string[] = [];
  let currentChunk = "";

  const pushChunk = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
  };

  for (const part of sentenceParts) {
    if (part.length > maxChars) {
      pushChunk(currentChunk);
      currentChunk = "";

      const words = part.split(/\s+/).filter(Boolean);
      let currentWordChunk = "";

      for (const word of words) {
        const candidate = currentWordChunk ? `${currentWordChunk} ${word}` : word;
        if (candidate.length <= maxChars) {
          currentWordChunk = candidate;
        } else {
          pushChunk(currentWordChunk);
          currentWordChunk = word;
        }
      }

      pushChunk(currentWordChunk);
      continue;
    }

    const candidate = currentChunk ? `${currentChunk} ${part}` : part;
    if (candidate.length <= maxChars) {
      currentChunk = candidate;
    } else {
      pushChunk(currentChunk);
      currentChunk = part;
    }
  }

  pushChunk(currentChunk);
  return chunks.length > 0 ? chunks : [normalized];
}

function buildSrtCue(index: number, startTime: number, endTime: number, dialogue: string): string {
  return `${index}\n${formatSRTTimestamp(startTime)} --> ${formatSRTTimestamp(
    endTime
  )}\n${dialogue}\n\n`;
}

export function generateSRT(subtitles: Subtitle[], videoLength: number): string {
  let srtContent = "";
  let cueIndex = 1;

  for (let i = 0; i < subtitles.length; i++) {
    const currentSub = subtitles[i];
    const nextSub = subtitles[i + 1];

    if (!currentSub) {
      continue;
    }

    const startTime = parseTimestamp(currentSub.timestamp);
    const nextStartTime = nextSub ? parseTimestamp(nextSub.timestamp) : null;
    const endTime =
      nextStartTime === null
        ? Math.max(videoLength, startTime)
        : Math.max(nextStartTime - 0.001, startTime);

    const dialogueChunks = splitLongDialogue(currentSub.dialogue);
    const cueDuration = Math.max(endTime - startTime, 0);
    const totalGapDuration = AUTO_CHUNK_GAP_SECONDS * Math.max(dialogueChunks.length - 1, 0);
    const availableDialogueDuration = Math.max(cueDuration - totalGapDuration, 0);
    const chunkDuration = availableDialogueDuration / dialogueChunks.length;

    for (let chunkIndex = 0; chunkIndex < dialogueChunks.length; chunkIndex++) {
      const chunk = dialogueChunks[chunkIndex];
      if (!chunk) {
        continue;
      }

      const gapOffset = AUTO_CHUNK_GAP_SECONDS * chunkIndex;
      const chunkStartTime = startTime + chunkDuration * chunkIndex + gapOffset;
      const chunkEndTime =
        chunkIndex === dialogueChunks.length - 1
          ? endTime
          : Math.max(chunkStartTime, chunkStartTime + chunkDuration - 0.001);

      srtContent += buildSrtCue(cueIndex, chunkStartTime, chunkEndTime, chunk);
      cueIndex++;
    }
  }

  return srtContent.trim();
}

export function splitCompositeSubtitleLine(line: string): string[] {
  return line
    .split(/\s+#\s+(?=\(?\d+(?::\d{1,2}){1,2})/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseSubtitleLine(
  line: string,
  warnOnInvalid = true
): Subtitle | null {
  const match = line
    .trim()
    .match(/^\(?([0-9:]+)\)?\s*([^:]+):\s*["“]?(.+?)["”]?$/u);

  if (!match?.[1] || !match[2] || !match[3]) {
    if (warnOnInvalid) {
      console.warn(chalk.yellow(`Warning: Invalid subtitle format: ${line}`));
    }
    return null;
  }

  const timestamp = match[1].trim();
  if (Number.isNaN(parseTimestamp(timestamp))) {
    if (warnOnInvalid) {
      console.warn(chalk.yellow(`Warning: Invalid subtitle timestamp: ${line}`));
    }
    return null;
  }

  return {
    timestamp,
    speaker: match[2].trim(),
    dialogue: match[3].trim().replace(/^["“]|["”]$/gu, ""),
  };
}

export function parseSubtitles(
  subtitleText: string,
  warnOnInvalid = true
): Subtitle[] {
  return subtitleText
    .split(/\r?\n/)
    .flatMap(splitCompositeSubtitleLine)
    .map((line) => parseSubtitleLine(line, warnOnInvalid))
    .filter((subtitle): subtitle is Subtitle => subtitle !== null);
}

export function validateSubtitleTimestamps(
  subtitles: Subtitle[],
  videoLength: number
): void {
  let previousStartTime = -Infinity;

  for (const subtitle of subtitles) {
    const startTime = parseTimestamp(subtitle.timestamp);

    if (startTime < previousStartTime) {
      throw new Error(
        chalk.red(
          `Subtitles must be in chronological order: "${subtitle.timestamp}" comes after a later timestamp.`
        )
      );
    }

    if (startTime > videoLength) {
      console.warn(
        chalk.yellow(
          `Warning: Subtitle at ${subtitle.timestamp} starts after the video length (${formatDurationLabel(
            videoLength
          )}).`
        )
      );
    }

    previousStartTime = startTime;
  }
}

function ensureSrtExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith(".srt") ? fileName : `${fileName}.srt`;
}

export function normalizeCommentAuthor(value: string | undefined): string {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?youtube\.com\//, "")
    .replace(/^@/, "")
    .replace(/[^a-z0-9]/g, "") ?? "";
}

export function getCommentAuthorCandidates(comment: YouTubeComment): string[] {
  const values = [comment.author, comment.author_id, comment.author_url]
    .map(normalizeCommentAuthor)
    .filter(Boolean);

  return [...new Set(values)];
}

export function isMatchingCommentAuthor(comment: YouTubeComment): boolean {
  const candidates = getCommentAuthorCandidates(comment);
  const expectedCandidates = COMMENT_AUTHOR_CANDIDATES.map(normalizeCommentAuthor);

  return expectedCandidates.some((expected) =>
    candidates.some(
      (candidate) =>
        candidate === expected ||
        candidate.includes(expected) ||
        expected.includes(candidate)
    )
  );
}

export function extractCommentText(comment: YouTubeComment): string {
  return comment.text?.trim() ?? "";
}

export function extractSubtitleTextFromComment(
  commentText: string
): string | null {
  const subtitleLines = commentText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap(splitCompositeSubtitleLine)
    .filter((line) => SUBTITLE_LINE_PATTERN.test(line));

  if (subtitleLines.length === 0) {
    return null;
  }

  return subtitleLines.join("\n");
}

export function findSubtitleComment(comments: YouTubeComment[]): string | null {
  const candidateComments = comments
    .filter(isMatchingCommentAuthor)
    .sort((left, right) => Number(right.is_pinned) - Number(left.is_pinned));

  for (const comment of candidateComments) {
    const extractedSubtitleText = extractSubtitleTextFromComment(
      extractCommentText(comment)
    );

    if (extractedSubtitleText && parseSubtitles(extractedSubtitleText, false).length > 0) {
      return extractedSubtitleText;
    }
  }

  return null;
}

export function appendCreditSubtitle(subtitleText: string, videoLength: number): string {
  const creditStart = Math.max(videoLength - 3, 0);
  const timestamp = formatDurationLabel(creditStart);
  const creditLine = `(${timestamp}) Credits: "${CREDIT_DIALOGUE}"`;
  const trimmedSubtitleText = subtitleText.trim();

  return trimmedSubtitleText ? `${trimmedSubtitleText}\n${creditLine}` : creditLine;
}

function startSpinner(label: string): Ora {
  if (activeSpinner) {
    activeSpinner.stop();
  }
  const spinner = ora(label).start();
  activeSpinner = spinner;
  return spinner;
}


function createCancellationHandler(rl: ReturnType<typeof createInterface>) {
  let spinnerCancelled = false;

  const cancel = () => {
    if (cliCancelled) {
      return;
    }

    cliCancelled = true;

    if (activeSpinner) {
      spinnerCancelled = true;
      activeSpinner.fail("Cancelled.");
    }

    try {
      cancelActiveSubprocess?.();
    } catch {
      // Ignore subprocess cleanup errors during cancellation.
    }

    rl.close();
  };

  const handleSigint = () => {
    cancel();
  };

  const handleKeypress = (_value: string, key: Keypress) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      cancel();
    }
  };

  process.on("SIGINT", handleSigint);

  if (input.isTTY) {
    emitKeypressEvents(input, rl);
    input.on("keypress", handleKeypress);
  }

  return {
    cleanup() {
      process.off("SIGINT", handleSigint);

      if (input.isTTY) {
        input.off("keypress", handleKeypress);
      }
    },
    spinnerCancelled() {
      return spinnerCancelled;
    },
  };
}

function getSrtPathFromVideo(videoPath: string): string {
  return join(
    dirname(videoPath),
    `${basename(videoPath, extname(videoPath))}.srt`
  );
}

export function getEmbeddedVideoPath(videoPath: string): string {
  return join(dirname(videoPath), `${basename(videoPath, extname(videoPath))}.subbed.mkv`);
}

function readStream(
  stream: ReadableStream<Uint8Array> | null | undefined
): Promise<string> {
  return stream ? new Response(stream).text() : Promise.resolve("");
}

async function runCommand(command: string[]): Promise<string> {
  let ownsCancelHandler = false;

  try {
    if (cliCancelled) {
      throw new CliCancelledError();
    }

    const spawnedSubprocess = Bun.spawn({
      cmd: command,
      stdout: "pipe",
      stderr: "pipe",
    });
    ownsCancelHandler = true;
    cancelActiveSubprocess = () => {
      spawnedSubprocess.kill("SIGINT");
    };

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      readStream(spawnedSubprocess.stdout),
      readStream(spawnedSubprocess.stderr),
      spawnedSubprocess.exited,
    ]);

    if (cliCancelled) {
      throw new CliCancelledError();
    }

    if (exitCode !== 0) {
      throw new Error(
        stderrText.trim() ||
          stdoutText.trim() ||
          `Command failed: ${command.join(" ")}`
      );
    }

    return stdoutText;
  } catch (error) {
    if (cliCancelled) {
      throw new CliCancelledError();
    }

    if (
      error instanceof Error &&
      (error.message.includes("No such file") || error.message.includes("ENOENT"))
    ) {
      throw new Error("`yt-dlp` is not installed or not available in PATH.");
    }

    throw error;
  } finally {
    if (ownsCancelHandler) {
      cancelActiveSubprocess = null;
    }
  }
}

async function fetchVideoMetadata(url: string): Promise<VideoMetadata> {
  const output = await runCommand([
    "yt-dlp",
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    url,
  ]);

  let metadata: Partial<VideoMetadata>;

  try {
    metadata = JSON.parse(output) as Partial<VideoMetadata>;
  } catch {
    throw new Error("yt-dlp returned invalid metadata.");
  }

  if (typeof metadata.duration !== "number" || metadata.duration <= 0) {
    throw new Error("Could not determine the video length from yt-dlp.");
  }

  return {
    title:
      typeof metadata.title === "string" && metadata.title.trim().length > 0
        ? metadata.title.trim()
        : "video",
    duration: metadata.duration,
  };
}

async function fetchYouTubeComments(url: string): Promise<YouTubeComment[]> {
  const output = await runCommand([
    "yt-dlp",
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    "--write-comments",
    url,
  ]);

  let metadata: { comments?: unknown };

  try {
    metadata = JSON.parse(output) as { comments?: unknown };
  } catch {
    throw new Error("yt-dlp returned invalid comment metadata.");
  }

  return Array.isArray(metadata.comments)
    ? (metadata.comments as YouTubeComment[])
    : [];
}

async function downloadVideo(url: string): Promise<string> {
  const output = await runCommand([
    "yt-dlp",
    "--no-progress",
    "--no-playlist",
    "--no-write-info-json",
    "--no-write-comments",
    "--no-write-description",
    "--no-write-thumbnail",
    "--print",
    "filename",
    "--print",
    "after_move:filepath",
    url,
  ]);

  const downloadedFilePath = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!downloadedFilePath) {
    throw new Error("yt-dlp finished without reporting the downloaded file path.");
  }

  return downloadedFilePath;
}

async function embedSubtitles(videoPath: string, srtPath: string): Promise<string> {
  const outputPath = getEmbeddedVideoPath(videoPath);

  await runCommand([
    "ffmpeg",
    "-y",
    "-i",
    videoPath,
    "-i",
    srtPath,
    "-map",
    "0",
    "-map",
    "1:0",
    "-c",
    "copy",
    "-c:s",
    "srt",
    "-metadata:s:s:0",
    "language=eng",
    outputPath,
  ]);

  return outputPath;
}

export function isYouTubeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "youtube.com" ||
    normalized === "youtu.be" ||
    normalized.endsWith(".youtube.com") ||
    normalized.endsWith(".youtu.be")
  );
}

function validateUrl(url: string): void {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(chalk.red("Invalid URL. Paste a full YouTube URL or press Enter for manual mode."));
  }

  if (!isYouTubeHostname(parsedUrl.hostname)) {
    throw new Error(
      chalk.red("That doesn't look like a YouTube URL. Paste a full YouTube URL or press Enter for manual mode.")
    );
  }
}

async function readSubtitleText(
  prompts: PromptReader
): Promise<string> {
  console.log(
    chalk.dim(
      "\nEnter the subtitle text (one subtitle per line, press Enter twice when finished):"
    )
  );

  const lines: string[] = [];

  while (true) {
    const line = await promptUser(prompts, "");
    if (line.trim() === "") {
      break;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

async function promptUser(
  prompts: PromptReader,
  question: string
): Promise<string> {
  output.write(chalk.dim(question));

  const nextLine = await prompts.next();
  if (nextLine.done) {
    throw new CliCancelledError();
  }

  return nextLine.value;
}

async function promptForVideoLength(prompts: PromptReader): Promise<number> {
  while (true) {
    const videoLengthInput = await promptUser(
      prompts,
      `Enter the video length in ${chalk.dim("mm:ss")} (e.g., 2:30): `
    );
    const videoLength = parseTimestamp(videoLengthInput || "2:30");

    if (!Number.isNaN(videoLength) && videoLength > 0) {
      return videoLength;
    }

    console.log(chalk.red("Invalid video length. Please enter a valid mm:ss value greater than 0."));
  }
}

async function promptForOutputFilePath(prompts: PromptReader): Promise<string> {
  while (true) {
    const outputFileName = await promptUser(
      prompts,
      `\nEnter the name for the output SRT file (e.g., ${chalk.dim("output.srt")}): `
    );
    const trimmedOutputFileName = outputFileName.trim();

    if (!trimmedOutputFileName) {
      console.log(chalk.red("Please enter a valid file name."));
      continue;
    }

    const candidatePath = ensureSrtExtension(trimmedOutputFileName);

    if (await Bun.file(candidatePath).exists()) {
      const overwriteAnswer = await promptUser(
        prompts,
        chalk.yellow(`"${candidatePath}" already exists. Overwrite? (y/N): `)
      );

      if (!/^y(es)?$/iu.test(overwriteAnswer.trim())) {
        continue;
      }
    }

    return candidatePath;
  }
}

function verifyDependencies(dependencies: string[]): void {
  const missingDependencies = dependencies.filter((dep) => !Bun.which(dep));

  if (missingDependencies.length === 0) {
    return;
  }

  console.log(chalk.red("Missing required system dependencies."));
  console.log(chalk.yellow("Please install the following dependencies and ensure they are in your system's PATH:"));
  missingDependencies.forEach((dep) => console.log(`- ${chalk.bold(dep)}`));
  process.exit(1);
}

function showWelcomeMessage(): void {
  const title = chalk.bold.blue("SRT CLI Generator");
  const description = chalk.dim("A simple CLI tool to generate .srt files.");
  console.log(
    boxen(`${title}\n${description}`, {
      padding: 1,
      margin: 1,
      borderStyle: "round",
      borderColor: "blue",
      title: "Welcome",
      titleAlignment: "center",
    })
  );
}

export async function main() {
  cliCancelled = false;
  activeSpinner = null;
  cancelActiveSubprocess = null;
  cleanupFilePaths = new Set<string>();

  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  const cancellationHandler = createCancellationHandler(rl);
  const prompts = rl[Symbol.asyncIterator]();
  const cliVideoUrl = process.argv[2]?.trim() ?? "";

  try {
    showWelcomeMessage();
    verifyDependencies(["yt-dlp", "ffmpeg"]);

    const videoUrl = cliVideoUrl
      ? cliVideoUrl
      : (
          await promptUser(
            prompts,
            "Paste a YouTube URL to auto-download and infer video length, or press Enter to continue manually: "
          )
        ).trim();

    let videoLength: number;
    let outputFilePath: string | null = null;
    let subtitleText: string | null = null;
    let downloadedVideoPath: string | null = null;
    let usedKakoeiSbiComment = false;

    if (videoUrl) {
      validateUrl(videoUrl);

      console.log();
      const metadataSpinner = startSpinner("Fetching video metadata");
      const metadata = await fetchVideoMetadata(videoUrl);
      metadataSpinner.succeed(chalk.green("Fetched video metadata."));
      videoLength = metadata.duration;
      console.log(
        `Found ${chalk.bold(`"${metadata.title}"`)} (${chalk.dim(
          formatDurationLabel(videoLength)
        )}).`
      );

      console.log();
      const commentsSpinner = startSpinner("Looking for a matching YouTube comment");

      try {
        const comments = await fetchYouTubeComments(videoUrl);
        subtitleText = findSubtitleComment(comments);

        if (subtitleText) {
          usedKakoeiSbiComment = true;
          commentsSpinner.succeed(chalk.green("Imported subtitles from a matching YouTube comment."));
        } else {
          commentsSpinner.warn(
            chalk.yellow("No parseable @KakoeiSbi comment found. Falling back to manual subtitle entry.")
          );
        }
      } catch (error) {
        commentsSpinner.fail(
          chalk.red(
            error instanceof Error
              ? `Could not load YouTube comments: ${error.message}`
              : "Could not load YouTube comments."
          )
        );
      }

    } else {
      videoLength = await promptForVideoLength(prompts);
    }

    if (!subtitleText) {
      subtitleText = await readSubtitleText(prompts);
      if (!subtitleText.trim()) {
        console.log(chalk.yellow("No subtitle text provided. Aborting."));
        return;
      }
    } else {
      console.log(chalk.blue("\nUsing subtitle text imported from YouTube comments."));
    }

    if (usedKakoeiSbiComment) {
      subtitleText = appendCreditSubtitle(subtitleText, videoLength);
    }

    const parsingSpinner = startSpinner("Processing subtitle text");
    const subtitles = parseSubtitles(subtitleText);

    if (subtitles.length === 0) {
      parsingSpinner.fail(chalk.red("No valid subtitles were found in the provided text."));
      return;
    }
    parsingSpinner.succeed(chalk.green(`Processed ${chalk.bold(subtitles.length)} subtitle entries.`));
    validateSubtitleTimestamps(subtitles, videoLength);

    if (videoUrl) {
      const downloadSpinner = startSpinner("Downloading video with yt-dlp");
      downloadedVideoPath = await downloadVideo(videoUrl);
      downloadSpinner.succeed(chalk.green("Downloaded video."));
      outputFilePath = getSrtPathFromVideo(downloadedVideoPath);
      cleanupFilePaths.add(downloadedVideoPath);
      cleanupFilePaths.add(outputFilePath);
      console.log(`Downloaded video to: ${chalk.bold(downloadedVideoPath)}`);
    }

    if (!outputFilePath) {
      outputFilePath = await promptForOutputFilePath(prompts);
    }

    const writingSpinner = startSpinner("Writing SRT file");
    const srtContent = generateSRT(subtitles, videoLength);
    await write(outputFilePath, srtContent);
    writingSpinner.succeed(chalk.green("Wrote SRT file."));
    cleanupFilePaths.add(outputFilePath);

    if (downloadedVideoPath) {
      const embedSpinner = startSpinner("Embedding subtitles into video with ffmpeg");
      const embeddedVideoPath = await embedSubtitles(downloadedVideoPath, outputFilePath);
      embedSpinner.succeed(chalk.green("Embedded subtitles into video."));
      await cleanupFiles([downloadedVideoPath, outputFilePath]);
      cleanupFilePaths.delete(downloadedVideoPath);
      cleanupFilePaths.delete(outputFilePath);
      console.log(chalk.dim(`Cleaned up intermediate files: ${downloadedVideoPath}, ${outputFilePath}`));
      console.log(chalk.green.bold(`\nSubtitled video generated successfully: ${embeddedVideoPath}`));
    } else {
      console.log(chalk.green.bold(`\n.srt file generated successfully: ${outputFilePath}`));
    }
  } catch (error) {
    if (isCliCancelledError(error) || cliCancelled) {
      await cleanupFiles(cleanupFilePaths);
      if (!cancellationHandler.spinnerCancelled()) {
        output.write(chalk.yellow("\nCancelled.\n"));
      }

      return;
    }

    throw error;
  } finally {
    cancellationHandler.cleanup();
    cliCancelled = false;
    cancelActiveSubprocess = null;
    activeSpinner = null;
    cleanupFilePaths = new Set<string>();
    rl.close();
  }
}

// Run the main function if this script is executed directly
if (import.meta.main) {
    main().catch((error) => {
        console.error(chalk.red("An error occurred:"), error);
        process.exit(1);
    });
}

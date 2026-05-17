import { write } from "bun";
import { unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline";

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

interface SpinnerHandle {
  stop(successMessage?: string): void;
  fail(errorMessage: string): void;
}

type PromptReader = AsyncIterableIterator<string>;

const COMMENT_AUTHOR_CANDIDATES = [
  "KakoeiSbi",
  "@KakoeiSbi",
  "https://www.youtube.com/@KakoeiSbi",
  "https://youtube.com/@KakoeiSbi",
];

const SUBTITLE_LINE_PATTERN =
  /^\s*\(?[0-9]+(?::[0-9]{1,2}){1,2}\)?\s*[^:]+:\s*["“]?.+["”]?\s*$/u;

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

export function generateSRT(subtitles: Subtitle[], videoLength: number): string {
  let srtContent = "";

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

    srtContent += `${i + 1}\n`;
    srtContent += `${formatSRTTimestamp(startTime)} --> ${formatSRTTimestamp(
      endTime
    )}\n`;
    srtContent += `${currentSub.dialogue}\n\n`;
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
      console.warn(`Warning: Invalid subtitle format: ${line}`);
    }
    return null;
  }

  const timestamp = match[1].trim();
  if (Number.isNaN(parseTimestamp(timestamp))) {
    if (warnOnInvalid) {
      console.warn(`Warning: Invalid subtitle timestamp: ${line}`);
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

function startSpinner(label: string): SpinnerHandle {
  if (!output.isTTY) {
    output.write(`${label}...\n`);
    return {
      stop(successMessage) {
        if (successMessage) {
          output.write(`${successMessage}\n`);
        }
      },
      fail(errorMessage) {
        output.write(`${errorMessage}\n`);
      },
    };
  }

  const frames = ["|", "/", "-", "\\"];
  let frameIndex = 0;
  output.write(`${frames[frameIndex]} ${label}`);

  const interval = setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    output.write(`\r${frames[frameIndex]} ${label}`);
  }, 120);

  const clear = (message: string) => {
    clearInterval(interval);
    output.write(`\r${message}${" ".repeat(Math.max(label.length + 2, 1))}\n`);
  };

  return {
    stop(successMessage = `${label} done.`) {
      clear(successMessage);
    },
    fail(errorMessage) {
      clear(errorMessage);
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
  try {
    const subprocess = Bun.spawn({
      cmd: command,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      readStream(subprocess.stdout),
      readStream(subprocess.stderr),
      subprocess.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        stderrText.trim() ||
          stdoutText.trim() ||
          `Command failed: ${command.join(" ")}`
      );
    }

    return stdoutText;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("No such file") || error.message.includes("ENOENT"))
    ) {
      throw new Error("`yt-dlp` is not installed or not available in PATH.");
    }

    throw error;
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

function validateUrl(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid URL. Paste a full YouTube URL or press Enter for manual mode.");
  }
}

async function readSubtitleText(
  prompts: PromptReader
): Promise<string> {
  console.log(
    "\nEnter the subtitle text (one subtitle per line, press Enter twice when finished):"
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
  output.write(question);

  const nextLine = await prompts.next();
  if (nextLine.done) {
    throw new Error("Input stream closed before the prompt was answered.");
  }

  return nextLine.value;
}

export async function main() {
  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  const prompts = rl[Symbol.asyncIterator]();
  const cliVideoUrl = process.argv[2]?.trim() ?? "";

  try {
    console.log("Welcome to the .srt Generator CLI!");

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

    if (videoUrl) {
      validateUrl(videoUrl);

      console.log();
      const metadataSpinner = startSpinner("Fetching video metadata");
      const metadata = await fetchVideoMetadata(videoUrl);
      metadataSpinner.stop("Fetched video metadata.");
      videoLength = metadata.duration;
      console.log(
        `Found \"${metadata.title}\" (${formatDurationLabel(videoLength)}).`
      );

      console.log();
      const commentsSpinner = startSpinner("Looking for a matching YouTube comment");

      try {
        const comments = await fetchYouTubeComments(videoUrl);
        subtitleText = findSubtitleComment(comments);

        if (subtitleText) {
          commentsSpinner.stop("Imported subtitles from a matching YouTube comment.");
        } else {
          commentsSpinner.stop(
            "No parseable @KakoeiSbi comment found. Falling back to manual subtitle entry."
          );
        }
      } catch (error) {
        commentsSpinner.fail(
          error instanceof Error
            ? `Could not load YouTube comments: ${error.message}`
            : "Could not load YouTube comments."
        );
      }

      const downloadSpinner = startSpinner("Downloading video with yt-dlp");
      downloadedVideoPath = await downloadVideo(videoUrl);
      downloadSpinner.stop("Downloaded video.");
      outputFilePath = getSrtPathFromVideo(downloadedVideoPath);
      console.log(`Downloaded video to: ${downloadedVideoPath}`);
    } else {
      const videoLengthInput = await promptUser(
        prompts,
        "Enter the video length in mm:ss (ex. 2:30): "
      );
      videoLength = parseTimestamp(videoLengthInput || "2:30");

      if (Number.isNaN(videoLength) || videoLength <= 0) {
        throw new Error("Invalid video length. Please enter a valid mm:ss value.");
      }
    }

    if (!subtitleText) {
      subtitleText = await readSubtitleText(prompts);
    } else {
      console.log("\nUsing subtitle text imported from YouTube comments.");
    }

    const parsingSpinner = startSpinner("Processing subtitle text");
    const subtitles = parseSubtitles(subtitleText);
    parsingSpinner.stop(`Processed ${subtitles.length} subtitle entries.`);

    if (subtitles.length === 0) {
      throw new Error("No valid subtitles were provided.");
    }

    if (!outputFilePath) {
      const outputFileName = await promptUser(
        prompts,
        "\nEnter the name for the output SRT file (e.g., output.srt): "
      );
      outputFilePath = ensureSrtExtension(outputFileName.trim() || "output");
    }

    const writingSpinner = startSpinner("Writing SRT file");
    const srtContent = generateSRT(subtitles, videoLength);
    await write(outputFilePath, srtContent);
    writingSpinner.stop("Wrote SRT file.");

    if (downloadedVideoPath) {
      const embedSpinner = startSpinner("Embedding subtitles into video with ffmpeg");
      const embeddedVideoPath = await embedSubtitles(downloadedVideoPath, outputFilePath);
      embedSpinner.stop("Embedded subtitles into video.");
      await Promise.all([unlink(downloadedVideoPath), unlink(outputFilePath)]);
      console.log(`Cleaned up intermediate files: ${downloadedVideoPath}, ${outputFilePath}`);
      console.log(`Subtitled video generated successfully: ${embeddedVideoPath}`);
    } else {
      console.log(`.srt file generated successfully: ${outputFilePath}`);
    }
  } finally {
    rl.close();
  }
}

// Run the main function if this script is executed directly
if (import.meta.main) {
    main().catch((error) => {
        console.error("An error occurred:", error);
        process.exit(1);
    });
}

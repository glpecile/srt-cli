import { write } from "bun";

interface Subtitle {
  timestamp: string;
  speaker: string;
  dialogue: string;
}

function parseTimestamp(timestamp: string): number {
  const match = timestamp.match(/(\d+):(\d+)/);
  if (match) {
    const minutes = match[1] ? Number.parseInt(match[1]) : 0;
    const seconds = match[2] ? Number.parseInt(match[2]) : 0;
    return minutes * 60 + seconds;
  }
  return 0;
}

function formatSRTTimestamp(seconds: number): string {
  const pad = (num: number): string => num.toString().padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${ms
    .toString()
    .padStart(3, "0")}`;
}

function generateSRT(subtitles: Subtitle[], videoLength: number): string {
  let srtContent = "";
  let index = 1;

  for (let i = 0; i < subtitles.length; i++) {
    const currentSub = subtitles[i];
    const nextSub = subtitles[i + 1];

    const startTime = currentSub ? parseTimestamp(currentSub.timestamp) : 0;
    let endTime: number;

    if (nextSub) {
      endTime = parseTimestamp(nextSub.timestamp) - 0.001; // Subtract 1ms to avoid overlap
    } else {
      endTime = videoLength; // Use video length for the last subtitle
    }

    srtContent += `${index}\n`;
    srtContent += `${formatSRTTimestamp(startTime)} --> ${formatSRTTimestamp(
      endTime
    )}\n`;
    if (currentSub)
      srtContent += `${currentSub.speaker}: ${currentSub.dialogue}\n\n`;

    index++;
  }

  return srtContent.trim();
}

async function promptUser(question: string): Promise<string> {
  process.stdout.write(question);
  return await new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
  });
}

export async function main() {
  console.log("Welcome to the .srt Generator CLI!");

  // Ask for video length
  const videoLengthInput = await promptUser(
    "Enter the video length in mm:ss (ex. 2:30) "
  );
  const videoLength = parseTimestamp(videoLengthInput || "2:30");

  if (Number.isNaN(videoLength) || videoLength <= 0) {
    console.error("Invalid video length. Please enter a valid format.");
    process.exit(1);
  }

  // Ask for subtitle text
  console.log("\nEnter the subtitle text (Press Enter twice when finished):");
  let subtitleText = "";
  let line: string | null = null;
  while (true) {
    line = await promptUser("");
    if (line === "") break;
    subtitleText += `${line}\n`;
  }

  // Ask for output file name
  const outputFileName = await promptUser(
    "\nEnter the name for the output SRT file (e.g., output.srt): "
  );

  // Process subtitles
  const subtitles = subtitleText
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const match = block.trim().match(/^\(([^)]+)\)\s*([^:]+):\s*"?(.+?)"?$/s);
      if (match?.[2] && match[3]) {
        return {
          timestamp: match[1],
          speaker: match[2].trim(),
          dialogue: match[3].trim().replace(/^"|"$/g, ""), // Remove leading/trailing quotes if present
        };
      }
      console.warn(`Warning: Invalid subtitle format: ${block}`);
      return null;
    })
    .filter((subtitle): subtitle is Subtitle => subtitle !== null);

  // Generate and write SRT content
  const srtContent = generateSRT(subtitles, videoLength);
  await write(`${outputFileName || "output"}.srt`, srtContent);
  console.log(`.srt file generated successfully: ${outputFileName}.srt`);
  // End the execution
  process.exit(0);
}

// Run the main function if this script is executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error("An error occurred:", error);
    process.exit(1);
  });
}

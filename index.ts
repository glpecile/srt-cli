import { write } from "bun";

interface Subtitle {
    timestamp: string;
    speaker: string;
    dialogue: string;
}

function parseTimestamp(timestamp: string): number {
    const match = timestamp.match(/(\d+):(\d+)/);
    if (match) {
        const minutes = parseInt(match[1]);
        const seconds = parseInt(match[2]);
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
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${ms.toString().padStart(3, "0")}`;
}

function generateSRT(subtitles: Subtitle[], videoLength: number): string {
    let srtContent = "";
    let index = 1;

    for (let i = 0; i < subtitles.length; i++) {
        const currentSub = subtitles[i];
        const nextSub = subtitles[i + 1];

        const startTime = parseTimestamp(currentSub.timestamp);
        let endTime: number;

        if (nextSub) {
            endTime = parseTimestamp(nextSub.timestamp) - 0.001; // Subtract 1ms to avoid overlap
        } else {
            endTime = videoLength; // Use video length for the last subtitle
        }

        srtContent += `${index}\n`;
        srtContent += `${formatSRTTimestamp(startTime)} --> ${formatSRTTimestamp(endTime)}\n`;
        srtContent += `${currentSub.speaker}: ${currentSub.dialogue}\n\n`;

        index++;
    }

    return srtContent.trim();
}

async function main() {
    const videoLength = parseTimestamp("2:30"); // Example video length in seconds (2:20)
    const subtitleText = `
(0:06) Subaru: "...So Mimi stuck firmly to Beako, and Beako was very confused since she was not used to that."


(0:12) Mimi: "You are saying that this gummy-cookie-like hairstyle is beautiful? I don't understand at all!"


(0:18) Beatrice: "It's irritating to be judged by kids like you who don't know anything about beau- Hey! Don't pull my hair!"


(0:24) Petra: "Subaru-sama, Beatrice is looking at you horrifically.


(0:29) Subaru: "We grow up by battling with things that we aren't used to. Beako often hates other people or stuff without any reason, so this is a challenge for her and we can just stand here and watch over her. Mom."


(0:40) Petra:"What…what do you mean by Mom? Well then…"


(0:49) Subaru: "It bugs me that Petra is the most mature one while there are many grown-ups among us."


(0:54) Subaru: "Well, although I am talking about being mature, I am not a mature one myself, as I always get comforted…"


(1:00) Emilia: "Since you can always calm yourself down in that way, I think I won't be able to understand you no matter how many times we quarrel. But, I love you being like this, Subaru."


(1:12) Beatrice: "It's bad to try earning something while your values are not proper enough. You only acted unreasonably and recklessly when you were alone. You are not alone now, so I will help you earn anything you want."


(1:28) Subaru: "I'm really getting too much love. But when it comes to Emilia, she even says something I completely don't understand to make me feel puzzled. I wish she could stop saying that she likes me or she thinks I'm cool so frequently."


(1:41) Subaru: "I know, it's impolite to come to your place and keep talking Emilia and the others. Rem, I wonder if we will be the same on the day you wake up…Well, I don't think we will change much. Maybe because I am too lame, or maybe because you will respect me as always…


(2:04) Rem: "No, you are not lame at all."


(2:09) Rem: "Maybe on that day,I will make you the SUBARU of me."


(2:12) Subaru: "Rem!"


(2:20) Subaru: "Rem, I promise… I will get you back to us one day.
    `;

    const subtitles = subtitleText
        .trim()
        .split(/\n{2,}/)
        .map((block) => {
            const match = block
                .trim()
                .match(/^\(([^)]+)\)\s*([^:]+):\s*"?(.+?)"?$/s);
            if (match) {
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

    const srtContent = generateSRT(subtitles, videoLength);
    await write("output.srt", srtContent);
    console.log("SRT file generated successfully: output.srt");
}

main();

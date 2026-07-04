import { describe, expect, test } from "bun:test";
import {
  appendCreditSubtitle,
  extractSubtitleTextFromComment,
  findSubtitleComment,
  generateSRT,
  getEmbeddedVideoPath,
  isMatchingCommentAuthor,
  isYouTubeHostname,
  parseSubtitles,
  parseTimestamp,
  splitLongDialogue,
  validateSubtitleTimestamps,
} from "./index.ts";

describe("parseTimestamp", () => {
  test("parses mm:ss timestamps", () => {
    expect(parseTimestamp("02:30")).toBe(150);
  });

  test("parses hh:mm:ss timestamps", () => {
    expect(parseTimestamp("1:02:03")).toBe(3723);
  });

  test("rejects invalid ranges", () => {
    expect(parseTimestamp("00:75")).toBeNaN();
    expect(parseTimestamp("1:70:00")).toBeNaN();
  });
});

describe("parseSubtitles", () => {
  test("parses one subtitle per line", () => {
    expect(
      parseSubtitles(
        '(00:00) Emilia: "Good morning."\n(00:05) Subaru: "Let\'s go."',
        false
      )
    ).toEqual([
      {
        timestamp: "00:00",
        speaker: "Emilia",
        dialogue: "Good morning.",
      },
      {
        timestamp: "00:05",
        speaker: "Subaru",
        dialogue: "Let's go.",
      },
    ]);
  });

  test("parses # separated subtitles on one line", () => {
    expect(
      parseSubtitles(
        '(00:00) A: "Hello" # 00:05 B: "World"',
        false
      )
    ).toEqual([
      {
        timestamp: "00:00",
        speaker: "A",
        dialogue: "Hello",
      },
      {
        timestamp: "00:05",
        speaker: "B",
        dialogue: "World",
      },
    ]);
  });

  test("ignores invalid lines when warnings are disabled", () => {
    expect(
      parseSubtitles(
        'Some intro text\n(00:00) A: "Hello"\nRandom note\n(00:05) B: "World"',
        false
      )
    ).toEqual([
      {
        timestamp: "00:00",
        speaker: "A",
        dialogue: "Hello",
      },
      {
        timestamp: "00:05",
        speaker: "B",
        dialogue: "World",
      },
    ]);
  });
});

describe("generateSRT", () => {
  test("uses the next subtitle time and video length", () => {
    expect(
      generateSRT(
        [
          {
            timestamp: "00:00",
            speaker: "A",
            dialogue: "Hello",
          },
          {
            timestamp: "00:05",
            speaker: "B",
            dialogue: "World",
          },
        ],
        10
      )
    ).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:04,998",
        "Hello",
        "",
        "2",
        "00:00:05,000 --> 00:00:10,000",
        "World",
      ].join("\n")
    );
  });

  test("derives the embedded video output path", () => {
    expect(getEmbeddedVideoPath("/tmp/video.webm")).toBe("/tmp/video.subbed.mkv");
    expect(getEmbeddedVideoPath("/tmp/My Clip.mp4")).toBe("/tmp/My Clip.subbed.mkv");
  });

  test("splits long dialogue into multiple readable cues", () => {
    const srt = generateSRT(
      [
        {
          timestamp: "00:00",
          speaker: "A",
          dialogue:
            "It is due to her gate being dysfunctional. Because her gate being broken makes her unable to use magic completely. Although they are a minority, there are still people who have to bear undesirable defects once they are born.",
        },
      ],
      9
    );

    expect(srt).toContain(
      "Because her gate being broken makes her unable to use magic completely."
    );
    expect(srt).toContain("00:00:02,280 --> 00:00:04,439");
    expect(srt).toContain("00:00:04,560 --> 00:00:06,719");

    expect(srt.split("\n\n").length).toBeGreaterThan(1);
  });
});

describe("subtitle post-processing", () => {
  test("splits long dialogue into bounded chunks", () => {
    const chunks = splitLongDialogue(
      "This is a very long subtitle sentence that should be broken into smaller parts so that it is easier to read on screen."
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 84)).toBe(true);
  });

  test("appends a KakoeiSbi credit subtitle near the end", () => {
    expect(appendCreditSubtitle('(00:00) A: "Hello"', 19)).toBe(
      '(00:00) A: "Hello"\n(0:16) Credits: "Subtitle translation credits: @KakoeiSbi"'
    );
  });
});

describe("isYouTubeHostname", () => {
  test("accepts standard and regional YouTube hostnames", () => {
    expect(isYouTubeHostname("youtube.com")).toBe(true);
    expect(isYouTubeHostname("www.youtube.com")).toBe(true);
    expect(isYouTubeHostname("m.youtube.com")).toBe(true);
    expect(isYouTubeHostname("music.youtube.com")).toBe(true);
    expect(isYouTubeHostname("youtu.be")).toBe(true);
  });

  test("rejects unrelated or spoofed hostnames", () => {
    expect(isYouTubeHostname("example.com")).toBe(false);
    expect(isYouTubeHostname("notyoutube.com")).toBe(false);
    expect(isYouTubeHostname("youtube.com.evil.com")).toBe(false);
  });
});

describe("validateSubtitleTimestamps", () => {
  test("accepts in-order timestamps within the video length", () => {
    expect(() =>
      validateSubtitleTimestamps(
        [
          { timestamp: "00:00", speaker: "A", dialogue: "Hi" },
          { timestamp: "00:05", speaker: "B", dialogue: "Hey" },
        ],
        10
      )
    ).not.toThrow();
  });

  test("throws when timestamps are out of order", () => {
    expect(() =>
      validateSubtitleTimestamps(
        [
          { timestamp: "00:05", speaker: "A", dialogue: "Hi" },
          { timestamp: "00:02", speaker: "B", dialogue: "Hey" },
        ],
        10
      )
    ).toThrow();
  });

  test("warns but does not throw when a timestamp exceeds the video length", () => {
    expect(() =>
      validateSubtitleTimestamps(
        [{ timestamp: "00:20", speaker: "A", dialogue: "Hi" }],
        10
      )
    ).not.toThrow();
  });
});

describe("YouTube comment helpers", () => {
  test("matches KakoeiSbi across fuzzy author forms", () => {
    expect(
      isMatchingCommentAuthor({
        author: "@KakoeiSbi",
      })
    ).toBe(true);

    expect(
      isMatchingCommentAuthor({
        author_url: "https://www.youtube.com/@KakoeiSbi",
      })
    ).toBe(true);

    expect(
      isMatchingCommentAuthor({
        author_id: "youtube.com/@kakoeisbi",
      })
    ).toBe(true);

    expect(
      isMatchingCommentAuthor({
        author: "someone-else",
      })
    ).toBe(false);
  });

  test("extracts only subtitle-looking lines from mixed comments", () => {
    expect(
      extractSubtitleTextFromComment(
        [
          "Episode 4 translation below",
          "",
          '(00:00) Emilia: "Good morning."',
          "Translator note: the joke is hard to localize",
          '(00:05) Subaru: "Let\'s go."',
          "Hope this helps",
        ].join("\n")
      )
    ).toBe('(00:00) Emilia: "Good morning."\n(00:05) Subaru: "Let\'s go."');
  });

  test("prefers pinned matching comments and returns extracted subtitles", () => {
    expect(
      findSubtitleComment([
        {
          author: "KakoeiSbi",
          text: '(00:00) A: "Wrong one"',
          is_pinned: false,
        },
        {
          author_url: "https://www.youtube.com/@KakoeiSbi",
          text: [
            "Pinned translation",
            '(00:00) A: "Hello"',
            '(00:05) B: "World"',
          ].join("\n"),
          is_pinned: true,
        },
      ])
    ).toBe('(00:00) A: "Hello"\n(00:05) B: "World"');
  });
});

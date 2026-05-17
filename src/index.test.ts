import { describe, expect, test } from "bun:test";
import {
  extractSubtitleTextFromComment,
  findSubtitleComment,
  generateSRT,
  isMatchingCommentAuthor,
  parseSubtitles,
  parseTimestamp,
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

# srt-cli

A small Command Line Input (CLI) that takes subtitle text and converts it into a `.srt` file.

## Why?

While watching re:zero season 3 I noticed the re:zero break time season 3 was airing simultaneously.

I wanted to watch the break time episodes with subtitles but couldn't find any.
That is until I saw a commentor by the name of [@KakoeiSbi](https://www.youtube.com/@KakoeiSbi) who translated the break time episodes in a specific format.

I decided then to create a CLI that would take the text and convert it into a `.srt` file and optionally download the matching video from YouTube.

## Optional YouTube Flow

If you paste a YouTube URL at the first prompt, the CLI will:

1. Fetch the video metadata with `yt-dlp`
2. Download the video with `yt-dlp`
3. Infer the video length automatically
4. Save the generated `.srt` next to the downloaded video

While the CLI is downloading, parsing, or writing files, it now shows a small loading state in the terminal.

If you press Enter instead, the CLI falls back to the original manual flow and asks for the video length and output file name.

To use the YouTube flow, make sure `yt-dlp` is installed and available in your `PATH`.

You can also pass the URL directly as the first CLI argument:

```bash
bun run src/index.ts "https://www.youtube.com/watch?v=..."
```

If the URL contains `?` or `&`, wrap it in quotes so your shell does not interpret it.

After loading a YouTube video, the CLI automatically tries to import subtitle text from a YouTube comment left by `@KakoeiSbi`. The author matching is fuzzy, so it can still match handle, channel URL, or similar author identifiers returned by `yt-dlp`. If no matching parseable comment is found, it falls back to manual subtitle entry.

## Run script from npm

```sh
npx srt-cli
```

Then follow the CLI steps.

The text entered should follow the format:

```sh
(mm:ss) <character>: "<dialogue>"
```

Each subtitle should be entered on its own line.

You can also place multiple subtitle entries on the same line by separating them with `#`:

```sh
(mm:ss) <character>: "<dialogue>" # mm:ss <character>: "<dialogue>"
```

The comment import feature expects the same subtitle format inside the YouTube comment text, but the comment can also include extra commentary before, after, or between subtitle lines. The CLI now extracts only the lines that look like subtitles.

## Run Locally

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.ts
```

The first prompt accepts an optional YouTube URL. Leave it blank to use manual mode.

You can skip that first prompt by passing a quoted YouTube URL as the first argument.

This project was created using `bun init` in bun v1.1.30. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

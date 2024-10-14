# text-to-sub-cli

A small Command Line Input (CLI) that takes a text file and converts it into a `.srt` file.

## Why?

While watching re:zero season 3 I noticed the re:zero break time season 3 was airing simultaneously.

I wanted to watch the break time episodes with subtitles but couldn't find any.
That is until I saw a commentor by the name of [@KakoeiSbi](https://www.youtube.com/@KakoeiSbi) who translated the break time episodes in a specific format.

I decided then to create a CLI that would take the text and convert it into a `.srt` file and then download the video from youtube with the subtitles.

## Run script from npm

```sh
npx srt-cli
```

Then follow the CLI steps.

## Run Locally

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.1.30. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

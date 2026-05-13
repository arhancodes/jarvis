import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { execSync } from 'child_process';
import { llmStreamChat } from '../utils/llm.js';

export class YouTubeToolsModule implements JarvisModule {
  name = 'youtube-tools' as const;
  description = 'Play, summarize, and explore YouTube videos';

  patterns: PatternDefinition[] = [
    {
      intent: 'play',
      patterns: [
        /^(?:search|find|look\s+up)\s+(?:on\s+)?(?:youtube|yt)\s+(?:for\s+)?(.+)/i,
        /^(?:search|find|look\s+up)\s+(.+?)\s+on\s+(?:youtube|yt)$/i,
        /^play\s+(.+?)\s+on\s+youtube$/i,
        /^(?:play|watch)\s+(.+?)\s+(?:on\s+)?(?:yt|youtube)$/i,
        /^youtube\s+play\s+(.+)/i,
        /^youtube\s+(?!trending|summarize|summary)(.+)/i,
      ],
      extract: (match) => ({ query: (match[1] || '').trim() }),
    },
    {
      intent: 'summarize',
      patterns: [
        /^summarize\s+(?:youtube\s+)?(?:video\s+)?(.+)/i,
        /^(?:youtube|yt)\s+summar(?:y|ize)\s+(.+)/i,
        /^(?:give me a |get )?\s*summary\s+(?:of\s+)?(?:this\s+)?(?:youtube\s+)?(?:video\s+)?(.+)/i,
      ],
      extract: (match) => ({ target: match[1].trim() }),
    },
    {
      intent: 'open-youtube',
      patterns: [
        /^(?:open|search|go\s+to)\s+(?:youtube|yt)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'trending',
      patterns: [
        /^(?:youtube|yt)\s+trending/i,
        /^what(?:'s| is)\s+trending\s+on\s+(?:youtube|yt)/i,
        /^trending\s+(?:on\s+)?(?:youtube|yt)/i,
        /^show\s+(?:me\s+)?(?:youtube|yt)\s+trending/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'play': return this.playVideo(command.args.query);
      case 'open-youtube': return this.openYouTube();
      case 'summarize': return this.summarizeVideo(command.args.target);
      case 'trending': return this.showTrending();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async openYouTube(): Promise<CommandResult> {
    execSync('open https://www.youtube.com');
    return { success: true, message: 'Opened YouTube' };
  }

  private async searchYouTube(query: string): Promise<{ id: string; title: string } | null> {
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://www.youtube.com/results?search_query=${encoded}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) return null;
      const html = await response.text();

      // Extract video ID from search results
      const videoIdMatch = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (!videoIdMatch) return null;

      const id = videoIdMatch[1];

      // Try to extract the title near the video ID
      const titleMatch = html.match(/"title":\s*\{"runs":\s*\[\{"text":\s*"([^"]+)"\}/);
      const title = titleMatch ? titleMatch[1] : query;

      return { id, title };
    } catch {
      return null;
    }
  }

  private extractVideoId(input: string): string | null {
    // Match youtube.com/watch?v=ID or youtu.be/ID
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
      const m = input.match(p);
      if (m) return m[1];
    }
    return null;
  }

  private async playVideo(query: string): Promise<CommandResult> {
    try {
      // Check if query is already a URL/ID
      const directId = this.extractVideoId(query);
      if (directId) {
        const url = `https://www.youtube.com/watch?v=${directId}`;
        execSync(`open "${url}"`);
        return {
          success: true,
          message: `Opening video: ${url}`,
          voiceMessage: 'Opening the video now.',
        };
      }

      // Search for the video
      const result = await this.searchYouTube(query);
      if (!result) {
        return { success: false, message: `Could not find a YouTube video for "${query}".` };
      }

      const url = `https://www.youtube.com/watch?v=${result.id}`;
      execSync(`open "${url}"`);

      return {
        success: true,
        message: `Playing "${result.title}"\n${url}`,
        voiceMessage: `Playing ${result.title} on YouTube.`,
      };
    } catch (err) {
      return { success: false, message: `Failed to play video: ${(err as Error).message}` };
    }
  }

  private async summarizeVideo(target: string): Promise<CommandResult> {
    try {
      let videoId = this.extractVideoId(target);
      let videoTitle = target;

      // If not a URL, search for it
      if (!videoId) {
        const result = await this.searchYouTube(target);
        if (!result) {
          return { success: false, message: `Could not find a YouTube video for "${target}".` };
        }
        videoId = result.id;
        videoTitle = result.title;
      }

      // Fetch the video page to get metadata
      const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
      let description = '';
      let title = videoTitle;

      try {
        const response = await fetch(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        if (response.ok) {
          const html = await response.text();

          // Extract title
          const titleMatch = html.match(/<title>(.+?)\s*-\s*YouTube<\/title>/);
          if (titleMatch) title = titleMatch[1];

          // Extract description from meta tag
          const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/) ||
            html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
          if (descMatch) {
            description = descMatch[1]
              .replace(/\\n/g, '\n')
              .replace(/\\"/g, '"')
              .substring(0, 2000);
          }

          // Try to extract channel name
          const channelMatch = html.match(/"ownerChannelName":"([^"]+)"/);
          if (channelMatch) {
            title = `${title} by ${channelMatch[1]}`;
          }
        }
      } catch {
        // Continue with what we have
      }

      // Use LLM to generate summary
      let summary = '';
      const systemPrompt = 'You are a helpful assistant that summarizes YouTube videos. Based on the video title and description provided, give a concise, informative summary of what the video is about. If the description is empty or minimal, do your best based on the title. Keep the summary to 3-5 sentences.';

      const userMessage = `Summarize this YouTube video:\n\nTitle: ${title}\nURL: ${pageUrl}\nDescription: ${description || '(no description available)'}`;

      try {
        summary = await llmStreamChat(
          [{ role: 'user', content: userMessage }],
          systemPrompt,
          () => {},
        );
      } catch {
        // Fallback if LLM is unavailable
        summary = description
          ? `"${title}" — ${description.substring(0, 300)}...`
          : `"${title}" — No description available. Watch at ${pageUrl}`;
      }

      return {
        success: true,
        message: `Video: ${title}\n${pageUrl}\n\nSummary:\n${summary}`,
        voiceMessage: summary,
        data: { videoId, title, url: pageUrl, summary },
      };
    } catch (err) {
      return { success: false, message: `Failed to summarize video: ${(err as Error).message}` };
    }
  }

  private async showTrending(): Promise<CommandResult> {
    try {
      const response = await fetch('https://www.youtube.com/feed/trending', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        return { success: false, message: 'Failed to fetch YouTube trending page.' };
      }

      const html = await response.text();

      // Extract video titles and IDs from the trending page
      const videos: Array<{ title: string; id: string }> = [];
      const seen = new Set<string>();

      // Match video data from the page's JSON
      const titleRegex = /"title":\s*\{"runs":\s*\[\{"text":\s*"([^"]+)"\}/g;
      const idRegex = /\/watch\?v=([a-zA-Z0-9_-]{11})/g;

      // Collect all video IDs
      const ids: string[] = [];
      let idMatch: RegExpExecArray | null;
      while ((idMatch = idRegex.exec(html)) !== null) {
        if (!seen.has(idMatch[1])) {
          seen.add(idMatch[1]);
          ids.push(idMatch[1]);
        }
        if (ids.length >= 10) break;
      }

      // Collect titles
      const titles: string[] = [];
      let titleMatch: RegExpExecArray | null;
      while ((titleMatch = titleRegex.exec(html)) !== null) {
        titles.push(titleMatch[1]);
        if (titles.length >= 10) break;
      }

      // Pair them up
      const count = Math.min(ids.length, titles.length, 5);
      for (let i = 0; i < count; i++) {
        videos.push({ title: titles[i], id: ids[i] });
      }

      // If we couldn't parse titles, just show IDs
      if (videos.length === 0 && ids.length > 0) {
        for (let i = 0; i < Math.min(ids.length, 5); i++) {
          videos.push({ title: `Video ${i + 1}`, id: ids[i] });
        }
      }

      if (videos.length === 0) {
        return { success: false, message: 'Could not parse trending videos. YouTube may have changed their page structure.' };
      }

      const list = videos
        .map((v, i) => `  ${i + 1}. ${v.title}\n     https://youtube.com/watch?v=${v.id}`)
        .join('\n');

      return {
        success: true,
        message: `Trending on YouTube:\n${list}`,
        voiceMessage: `Here are the top trending videos: ${videos.map(v => v.title).join(', ')}.`,
        data: videos,
      };
    } catch (err) {
      return { success: false, message: `Failed to fetch trending: ${(err as Error).message}` };
    }
  }

  getHelp(): string {
    return [
      '  YouTube Tools — play, summarize, and explore videos',
      '    play <query> on youtube    Search and play a video',
      '    youtube <query>            Search and play a video',
      '    summarize youtube <url>    Summarize a YouTube video',
      '    youtube trending           Show trending videos',
    ].join('\n');
  }
}

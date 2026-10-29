import tokens from '../styles/brand/tokens.css?raw';

/**
 * The light theme's page background (`--surface`, its first declaration in
 * tokens.css), for the places that need a colour as text rather than a CSS
 * variable: `<meta name="theme-color">` and the web manifest.
 */
const match = tokens.match(/--surface:\s*(#[0-9a-fA-F]{3,8})/);
if (!match) throw new Error('tokens.css declares no --surface colour');

export const surfaceColor: string = match[1];

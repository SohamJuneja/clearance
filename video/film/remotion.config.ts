import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setPixelFormat("yuv420p");
Config.setColorSpace("bt709"); // one colourspace for every part, or joins reset the filters
Config.setChromiumOpenGlRenderer("swangle"); // the 3D stack needs WebGL; angle has no context on this headless host
Config.setConcurrency(6);

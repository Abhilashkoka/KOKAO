{pkgs}: {
  deps = [
    pkgs.ffmpeg
    pkgs.chromium
    # Video localization burns Telugu, Tamil and Devanagari subtitles through
    # libass, which needs a real font for each script installed on the host.
    # fontconfig provides fc-match, which the renderer uses to resolve one —
    # and to refuse the render when none is present, rather than shipping tofu.
    pkgs.fontconfig
    pkgs.noto-fonts
    pkgs.noto-fonts-extra
  ];
}

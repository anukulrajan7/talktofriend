// Go SFU for TalkToFriend.
//
// This is the media-routing engine. Node.js remains the signaling brain.
// They communicate over HTTP on localhost.
//
// Usage:
//   ANNOUNCED_IP=1.2.3.4 PORT=3200 go run ./cmd/sfu
//
// Env vars:
//   PORT          — HTTP API port (default 3200)
//   ANNOUNCED_IP  — Public IP for WebRTC ICE candidates (required in prod)
//   RTC_MIN_PORT  — Min UDP port for WebRTC (default 40000)
//   RTC_MAX_PORT  — Max UDP port for WebRTC (default 40200)
//   LOG_LEVEL     — debug, info, warn, error (default info)

package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/anukulrajan7/talktofriend/sfu/internal/server"
)

func main() {
	// Structured logging
	level := slog.LevelInfo
	switch os.Getenv("LOG_LEVEL") {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))

	port := os.Getenv("PORT")
	if port == "" {
		port = "3200"
	}

	sfu, err := server.New()
	if err != nil {
		slog.Error("failed to create SFU server", "err", err)
		os.Exit(1)
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		slog.Info("shutting down", "signal", sig)
		os.Exit(0)
	}()

	addr := fmt.Sprintf("127.0.0.1:%s", port)
	slog.Info("starting Go SFU",
		"addr", addr,
		"announced_ip", os.Getenv("ANNOUNCED_IP"),
		"rtc_ports", fmt.Sprintf("%s-%s", envOr("RTC_MIN_PORT", "40000"), envOr("RTC_MAX_PORT", "40200")),
	)

	if err := sfu.ListenAndServe(addr); err != nil {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

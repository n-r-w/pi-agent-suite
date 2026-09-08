package main

import (
	"context"
	"net/http"
	"strconv"
)

type imageReader interface {
	ReadImage(context.Context) ([]byte, error)
}

func newImageHandler(reader imageReader) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/image" {
			http.NotFound(writer, request)
			return
		}

		image, err := reader.ReadImage(request.Context())
		if err != nil {
			http.Error(writer, "clipboard image read failed", http.StatusInternalServerError)
			return
		}
		if len(image) == 0 {
			writer.WriteHeader(http.StatusNoContent)
			return
		}

		writer.Header().Set("Content-Type", "image/png")
		writer.Header().Set("Content-Length", strconv.Itoa(len(image)))
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(image)
	})
}

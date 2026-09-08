package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.design/x/clipboard"
)

type fakeImageReader struct {
	image []byte
	err   error
}

func (f fakeImageReader) ReadImage(context.Context) ([]byte, error) {
	return f.image, f.err
}

func TestNormalizeClipboardImageTreatsNoDataAsEmpty(t *testing.T) {
	// Purpose: the clipboard library's empty-image signal must map to HTTP 204, not HTTP 500.
	// Input and expected output: clipboard.ErrNoData returns nil bytes and no error.
	// Edge case: other clipboard errors remain errors.
	// Dependencies: the sentinel comes from the selected clipboard library.
	image, err := normalizeClipboardImage(nil, clipboard.ErrNoData)
	if err != nil || image != nil {
		t.Fatalf("result = %v, %v, want nil, nil", image, err)
	}
	otherError := errors.New("clipboard unavailable")
	if _, err := normalizeClipboardImage(nil, otherError); !errors.Is(err, otherError) {
		t.Fatalf("error = %v, want %v", err, otherError)
	}
}

func TestImageHandlerReturnsPNG(t *testing.T) {
	// Purpose: expose the clipboard image as one PNG response.
	// Input and expected output: PNG bytes produce HTTP 200, image/png, and the same body.
	// Edge case: binary bytes are not transformed.
	// Dependencies: clipboard access uses a deterministic fake.
	image := []byte{137, 80, 78, 71, 1}
	request := httptest.NewRequest(http.MethodGet, "/image", nil)
	response := httptest.NewRecorder()

	newImageHandler(fakeImageReader{image: image}).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if got := response.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content type = %q, want image/png", got)
	}
	if got := response.Body.Bytes(); string(got) != string(image) {
		t.Fatalf("body = %v, want %v", got, image)
	}
}

func TestImageHandlerReportsEmptyClipboard(t *testing.T) {
	// Purpose: distinguish an empty clipboard from a helper failure.
	// Input and expected output: nil image bytes produce HTTP 204.
	// Edge case: an empty slice is also empty.
	// Dependencies: clipboard access uses a deterministic fake.
	for _, image := range [][]byte{nil, {}} {
		request := httptest.NewRequest(http.MethodGet, "/image", nil)
		response := httptest.NewRecorder()
		newImageHandler(fakeImageReader{image: image}).ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
		}
	}
}

func TestImageHandlerReportsClipboardFailure(t *testing.T) {
	// Purpose: transfer failures must be visible to the remote extension.
	// Input and expected output: a clipboard read error produces HTTP 500.
	// Edge case: no image bytes are returned with the error.
	// Dependencies: clipboard access uses a deterministic fake.
	request := httptest.NewRequest(http.MethodGet, "/image", nil)
	response := httptest.NewRecorder()
	newImageHandler(fakeImageReader{err: errors.New("clipboard failed")}).ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusInternalServerError)
	}
}

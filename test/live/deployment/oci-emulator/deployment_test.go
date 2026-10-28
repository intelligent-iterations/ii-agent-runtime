package deploymenttest

import (
	"context"
	"fmt"
	ociprovider "github.com/stackshy/cloudemu/v2/providers/oci"
	ociserver "github.com/stackshy/cloudemu/v2/server/oci"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestGeneratedDeployment(t *testing.T) {
	handler := ociserver.New(ociserver.DriversFrom(ociprovider.New()))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(os.Stderr, "OCI emulator: %s %s\n", r.Method, r.URL.Path)
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "../oci.py")
	cmd.Env = append(os.Environ(), "II_OCI_EMULATOR_ENDPOINT="+server.URL)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	server.Close()
	client := &http.Client{Timeout: time.Second}
	if response, err := client.Get(server.URL); err == nil {
		response.Body.Close()
		t.Fatal("emulator still listening")
	}
	t.Log("emulator cleanup confirmed")
}

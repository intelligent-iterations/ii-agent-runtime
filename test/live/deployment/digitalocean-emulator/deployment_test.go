package deploymenttest

import (
	"context"
	"encoding/json"
	"github.com/gravel-project/gravel/cloud/digitalocean/dotest"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestGeneratedDeployment(t *testing.T) {
	var endpoint string
	t.Run("lifecycle", func(t *testing.T) {
		server := dotest.New(t, dotest.WithActionDelay(100*time.Millisecond))
		endpoint = server.URL()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "python3", "../digitalocean.py")
		cmd.Env = append(os.Environ(), "II_DO_EMULATOR_ENDPOINT="+server.URL())
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, request := range server.Requests() {
			if request.Method == "POST" && request.Path == "/v2/droplets" && request.Authorized {
				var body map[string]any
				if err := json.Unmarshal([]byte(request.Body), &body); err != nil {
					t.Fatal(err)
				}
				if body["monitoring"] != true || !strings.Contains(body["user_data"].(string), "docker.io") {
					t.Fatal("missing generated bootstrap/monitoring")
				}
				found = true
			}
		}
		if !found {
			t.Fatal("provider sent no droplet create")
		}
	})
	client := &http.Client{Timeout: time.Second}
	if response, err := client.Get(endpoint + "/v2/droplets"); err == nil {
		response.Body.Close()
		t.Fatal("emulator still listening after cleanup")
	}
	t.Log("emulator cleanup confirmed")
}

package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

const textPreviewLimit = 256 * 1024
const textPreviewLines = 3000

type TextPreview struct {
	Content   string `json:"content"`
	Encoding  string `json:"encoding"`
	Truncated bool   `json:"truncated"`
	Size      int64  `json:"size"`
}

func readTextPreview(r io.Reader, size int64) (*TextPreview, error) {
	data, err := io.ReadAll(io.LimitReader(r, textPreviewLimit+1))
	if err != nil {
		return nil, err
	}
	truncated := len(data) > textPreviewLimit
	if truncated {
		data = data[:textPreviewLimit]
	}
	text, encoding, err := decodePreviewText(data, truncated)
	if err != nil {
		return nil, err
	}
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	for _, c := range text {
		if c == 0 || (c < 32 && c != '\n' && c != '\t' && c != '\f' && c != 27) {
			return nil, fmt.Errorf("该文件包含二进制内容，无法作为文本预览")
		}
	}
	lines := strings.SplitN(text, "\n", textPreviewLines+1)
	if len(lines) > textPreviewLines {
		text = strings.Join(lines[:textPreviewLines], "\n")
		truncated = true
	}
	return &TextPreview{Content: text, Encoding: encoding, Truncated: truncated, Size: size}, nil
}

func decodePreviewText(data []byte, truncated bool) (string, string, error) {
	if bytes.HasPrefix(data, []byte{0xff, 0xfe}) || bytes.HasPrefix(data, []byte{0xfe, 0xff}) {
		var order binary.ByteOrder = binary.LittleEndian
		label := "UTF-16 LE"
		if data[0] == 0xfe {
			order = binary.BigEndian
			label = "UTF-16 BE"
		}
		data = data[2:]
		if len(data)%2 != 0 {
			if !truncated {
				return "", "", fmt.Errorf("UTF-16 文件不完整")
			}
			data = data[:len(data)-1]
		}
		units := make([]uint16, len(data)/2)
		for i := range units {
			units[i] = order.Uint16(data[i*2:])
		}
		if truncated && len(units) > 0 && units[len(units)-1] >= 0xd800 && units[len(units)-1] <= 0xdbff {
			units = units[:len(units)-1]
		}
		return string(utf16.Decode(units)), label, nil
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	if utf8.Valid(data) {
		return string(data), "UTF-8", nil
	}
	if truncated {
		for n := 1; n < utf8.UTFMax && n <= len(data); n++ {
			if utf8.Valid(data[:len(data)-n]) {
				return string(data[:len(data)-n]), "UTF-8", nil
			}
		}
	}
	decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes(data)
	text := string(decoded)
	if truncated {
		text = strings.TrimRight(text, "\ufffd")
	}
	if err != nil || strings.ContainsRune(text, utf8.RuneError) {
		return "", "", fmt.Errorf("无法识别文本编码，请使用本地编辑器打开")
	}
	return text, "GB18030 / GBK", nil
}

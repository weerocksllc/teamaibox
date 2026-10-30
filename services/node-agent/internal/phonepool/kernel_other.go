//go:build !linux

package phonepool

import "errors"

func New(Config) (*Pool, error) { return nil, errors.New("phone_pool_linux_required") }

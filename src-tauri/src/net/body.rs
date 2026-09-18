//! 请求体的构造（spec: 请求体类型）。
//!
//! 文件类正文只接受一次性句柄；句柄在这里被消费，且同一句柄不可重复使用。

use super::uploads::UploadRegistry;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::variables::{ResolvedBody, ResolvedFormField};
use reqwest::multipart::{Form, Part};
use reqwest::Body;
use tokio_util::io::ReaderStream;

pub enum BuiltBody {
    None,
    Bytes {
        data: Vec<u8>,
        /// 需要补上的 Content-Type（用户已显式指定时为空）。
        content_type: Option<String>,
    },
    Form(Vec<(String, String)>),
    Multipart(Box<Form>),
    Stream {
        body: Body,
        content_type: Option<String>,
    },
}

/// 根据解析后的正文构造实际发送体。
///
/// `content_type_configured` 表示用户已经显式设置了 Content-Type 头，
/// 此时不再用类型推断出的值覆盖它。
pub async fn build(
    body: &ResolvedBody,
    uploads: &UploadRegistry,
    content_type_configured: bool,
) -> AppResult<BuiltBody> {
    match body {
        ResolvedBody::None => Ok(BuiltBody::None),

        ResolvedBody::Raw { text, content_type } => Ok(BuiltBody::Bytes {
            data: text.as_bytes().to_vec(),
            content_type: (!content_type_configured).then(|| content_type.clone()),
        }),

        ResolvedBody::UrlEncoded { pairs } => Ok(BuiltBody::Form(pairs.clone())),

        ResolvedBody::FormData { fields } => {
            let mut form = Form::new();
            for field in fields {
                match field {
                    ResolvedFormField::Text { key, value } => {
                        form = form.text(key.clone(), value.clone());
                    }
                    ResolvedFormField::File { key, handle } => {
                        if handle.trim().is_empty() {
                            return Err(AppError::invalid_input(format!(
                                "表单文件字段「{}」尚未选择文件",
                                key
                            )));
                        }
                        let path = uploads.take(handle)?;
                        let part = Part::file(&path).await.map_err(|err| {
                            AppError::new(
                                ErrorCode::Io,
                                format!("无法读取上传文件：{}", err),
                            )
                        })?;
                        form = form.part(key.clone(), part);
                    }
                }
            }
            Ok(BuiltBody::Multipart(Box::new(form)))
        }

        ResolvedBody::Binary { handle, .. } => {
            let handle = handle
                .as_deref()
                .filter(|handle| !handle.trim().is_empty())
                .ok_or_else(|| AppError::invalid_input("二进制正文尚未选择文件"))?;
            let path = uploads.take(handle)?;

            let file = tokio::fs::File::open(&path).await.map_err(|err| {
                AppError::new(ErrorCode::Io, format!("无法读取上传文件：{}", err))
            })?;
            let content_type = mime_guess::from_path(&path)
                .first()
                .map(|mime| mime.essence_str().to_string());

            Ok(BuiltBody::Stream {
                body: Body::wrap_stream(ReaderStream::new(file)),
                content_type: (!content_type_configured).then_some(content_type).flatten(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn uploads_with(dir: &TempDir, name: &str, content: &[u8]) -> (UploadRegistry, String) {
        let path = dir.join(name);
        std::fs::write(&path, content).expect("写入临时文件");
        let registry = UploadRegistry::new();
        let handle = registry.register(&path).expect("登记文件");
        (registry, handle)
    }

    /// `BuiltBody` 含有不可 Debug 的网络类型，这里自己做断言解包。
    fn expect_err(result: AppResult<BuiltBody>, context: &str) -> AppError {
        match result {
            Ok(_) => panic!("{}", context),
            Err(err) => err,
        }
    }

    #[tokio::test]
    async fn none_body_builds_nothing() {
        let uploads = UploadRegistry::new();
        let built = build(&ResolvedBody::None, &uploads, false).await.unwrap();
        assert!(matches!(built, BuiltBody::None));
    }

    #[tokio::test]
    async fn raw_body_carries_its_content_type_unless_overridden() {
        let uploads = UploadRegistry::new();
        let body = ResolvedBody::Raw {
            text: "{\"a\":1}".into(),
            content_type: "application/json".into(),
        };

        match build(&body, &uploads, false).await.unwrap() {
            BuiltBody::Bytes { data, content_type } => {
                assert_eq!(data, b"{\"a\":1}");
                assert_eq!(content_type.as_deref(), Some("application/json"));
            }
            _ => panic!("期望 Bytes"),
        }

        match build(&body, &uploads, true).await.unwrap() {
            BuiltBody::Bytes { content_type, .. } => {
                assert!(content_type.is_none(), "用户已设置 Content-Type 时不应覆盖");
            }
            _ => panic!("期望 Bytes"),
        }
    }

    #[tokio::test]
    async fn urlencoded_body_builds_a_form() {
        let uploads = UploadRegistry::new();
        let body = ResolvedBody::UrlEncoded {
            pairs: vec![("a".into(), "1".into()), ("b".into(), "2".into())],
        };
        match build(&body, &uploads, false).await.unwrap() {
            BuiltBody::Form(pairs) => assert_eq!(pairs.len(), 2),
            _ => panic!("期望 Form"),
        }
    }

    #[tokio::test]
    async fn text_only_form_data_does_not_need_a_file() {
        let uploads = UploadRegistry::new();
        let body = ResolvedBody::FormData {
            fields: vec![ResolvedFormField::Text {
                key: "note".into(),
                value: "hi".into(),
            }],
        };
        assert!(matches!(
            build(&body, &uploads, false).await.unwrap(),
            BuiltBody::Multipart(_)
        ));
    }

    #[tokio::test]
    async fn multipart_file_field_consumes_its_handle_once() {
        let dir = TempDir::new("body-multipart");
        let (uploads, handle) = uploads_with(&dir, "payload.txt", b"file-content");
        let body = ResolvedBody::FormData {
            fields: vec![
                ResolvedFormField::Text {
                    key: "note".into(),
                    value: "hi".into(),
                },
                ResolvedFormField::File {
                    key: "file".into(),
                    handle: handle.clone(),
                },
            ],
        };

        assert!(build(&body, &uploads, false).await.is_ok());

        let err = expect_err(build(&body, &uploads, false).await, "第二次应失败");
        assert_eq!(err.code, ErrorCode::UploadHandleConsumed);
    }

    #[tokio::test]
    async fn form_file_field_without_a_chosen_file_is_rejected() {
        let uploads = UploadRegistry::new();
        let body = ResolvedBody::FormData {
            fields: vec![ResolvedFormField::File {
                key: "file".into(),
                handle: String::new(),
            }],
        };
        let err = expect_err(build(&body, &uploads, false).await, "应拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[tokio::test]
    async fn binary_body_streams_from_the_file_handle() {
        let dir = TempDir::new("body-binary");
        let (uploads, handle) = uploads_with(&dir, "blob.bin", b"\x00\x01\x02");

        let body = ResolvedBody::Binary {
            handle: Some(handle),
            description: Some("blob.bin".into()),
        };
        match build(&body, &uploads, false).await.unwrap() {
            BuiltBody::Stream { content_type, .. } => {
                assert!(
                    content_type.as_deref().unwrap_or("").contains("octet-stream")
                        || content_type.is_some(),
                    "应按扩展名推断内容类型，得到 {:?}",
                    content_type
                );
            }
            _ => panic!("期望 Stream"),
        }
    }

    #[tokio::test]
    async fn binary_body_without_a_handle_is_rejected() {
        let uploads = UploadRegistry::new();
        let body = ResolvedBody::Binary {
            handle: None,
            description: None,
        };
        let err = expect_err(build(&body, &uploads, false).await, "应拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[tokio::test]
    async fn invalid_handle_is_reported() {
        let uploads = UploadRegistry::new();
        let body = ResolvedBody::FormData {
            fields: vec![ResolvedFormField::File {
                key: "file".into(),
                handle: "forged-handle".into(),
            }],
        };
        let err = expect_err(build(&body, &uploads, false).await, "应拒绝");
        assert_eq!(err.code, ErrorCode::UploadHandleInvalid);
    }
}

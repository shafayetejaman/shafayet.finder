import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: paneRoot

  property bool isImage: false
  property string source: ""
  property string meta: ""
  property string content: ""
  property bool unavailable: false
  property string fontFamily: Style.font.menuFamily
  property int captionSize: 12
  property int contentSize: 13
  property int displayLargeSize: 18
  property int leftPad: Style.spacing.panelPadding

  signal imageFailed()

  clip: true

  Rectangle {
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    width: Style.normalBorderWidth
    color: Util.alpha(Color.menu.border, 0.28)
  }

  Text {
    visible: paneRoot.meta.length > 0
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.leftMargin: paneRoot.leftPad
    text: paneRoot.meta
    textFormat: Text.PlainText
    color: Color.menu.text
    opacity: 0.55
    font.family: paneRoot.fontFamily
    font.pixelSize: paneRoot.captionSize
    elide: Text.ElideRight
  }

  Text {
    visible: !paneRoot.isImage
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.bottom: parent.bottom
    anchors.right: parent.right
    anchors.leftMargin: paneRoot.leftPad
    anchors.topMargin: paneRoot.meta.length > 0 ? Style.space(22) : 0
    text: paneRoot.content
    textFormat: Text.PlainText
    color: Color.menu.text
    font.family: paneRoot.fontFamily
    font.pixelSize: paneRoot.contentSize
    wrapMode: Text.WrapAnywhere
    elide: Text.ElideRight
    verticalAlignment: Text.AlignTop
  }

  Image {
    id: previewImage
    visible: paneRoot.isImage && status !== Image.Error
    anchors.fill: parent
    anchors.leftMargin: paneRoot.leftPad
    source: paneRoot.source
    fillMode: Image.PreserveAspectFit
    verticalAlignment: Image.AlignTop
    asynchronous: true
    smooth: true
    onStatusChanged: {
      if (paneRoot.source === "") return
      // Any undecodable image must surface the placeholder: Error
      // alone misses Null, which would leave a silent blank pane.
      if (status === Image.Error || status === Image.Null) paneRoot.imageFailed()
    }
  }

  Column {
    anchors.centerIn: parent
    spacing: Style.space(8)
    visible: paneRoot.unavailable

    Text {
      text: String.fromCodePoint(0xF0DD1)
      color: Color.menu.selectedText
      opacity: 0.8
      font.family: paneRoot.fontFamily
      font.pixelSize: paneRoot.displayLargeSize
      horizontalAlignment: Text.AlignHCenter
      width: parent.width
    }

    Text {
      text: "Unable to preview"
      color: Color.menu.text
      opacity: 0.7
      font.family: paneRoot.fontFamily
      font.pixelSize: paneRoot.contentSize
      horizontalAlignment: Text.AlignHCenter
      width: parent.width
    }
  }
}
